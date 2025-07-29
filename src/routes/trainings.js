const express = require('express');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');
const checkAccess = require('../middleware/checkAccess');
const authorizeFeature = require('../middleware/authorizeFeature');
const AWS = require('aws-sdk');
const { v4: uuidv4 } = require('uuid');
const moment = require('moment');

const dynamodb = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();
const TRAININGS_TABLE = process.env.TRAININGS_TABLE || 'hris_trainings';
const EMPLOYEES_TABLE = process.env.EMPLOYEES_TABLE || 'hris_employees';
const DOCUMENT_BUCKET = process.env.DOCUMENT_BUCKET || 'hris-documents';

// POST /trainings - Create a new training program (HR & Managers)
router.post('/', verifyToken, checkAccess(3), authorizeFeature('training.manage'), async (req, res) => {
  try {
    const {
      title,
      description,
      type,
      category,
      startDate,
      endDate,
      location,
      instructor,
      maxParticipants,
      requiredFor,
      skills,
      materials,
      status = 'scheduled'
    } = req.body;
    
    // Validate required fields
    if (!title || !description || !type || !startDate || !endDate) {
      return res.status(400).json({ 
        message: 'Missing required fields: title, description, type, startDate, and endDate are required' 
      });
    }
    
    const trainingId = uuidv4();
    const timestamp = new Date().toISOString();
    
    // Convert dates to ISO format if they're not already
    const formattedStartDate = moment(startDate).toISOString();
    const formattedEndDate = moment(endDate).toISOString();
    
    const newTraining = {
      PK: `TRAINING#${trainingId}`,
      SK: `INFO`,
      trainingId,
      title,
      description,
      type,
      category,
      startDate: formattedStartDate,
      endDate: formattedEndDate,
      location,
      instructor,
      maxParticipants: maxParticipants || null,
      currentParticipants: 0,
      requiredFor: requiredFor || [],
      skills: skills || [],
      materials: materials || [],
      status,
      createdBy: req.user.id,
      createdByName: req.user.name,
      createdAt: timestamp,
      updatedAt: timestamp,
      GSI1PK: `TRAINING#STATUS`,
      GSI1SK: `${status}#${formattedStartDate}`,
      GSI2PK: `TRAINING#CATEGORY`,
      GSI2SK: `${category || 'general'}#${formattedStartDate}`
    };
    
    await dynamodb.put({
      TableName: TRAININGS_TABLE,
      Item: newTraining
    }).promise();
    
    // If this training is required for certain departments/roles,
    // notify relevant employees
    if (requiredFor && requiredFor.length > 0) {
      // This would be handled by a notification system
      console.log(`Training ${trainingId} is required for: ${JSON.stringify(requiredFor)}`);
    }
    
    return res.status(201).json({
      message: 'Training program created successfully',
      training: newTraining
    });
  } catch (error) {
    console.error('Error creating training program:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// GET /trainings - Get all training programs (with filters)
router.get('/', verifyToken, async (req, res) => {
  try {
    const { status, category, type, upcoming, past, limit, required } = req.query;
    const currentUser = req.user;
    
    // Base query parameters
    let params = {};
    
    // Filter by status if provided
    if (status) {
      params = {
        TableName: TRAININGS_TABLE,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :status)',
        ExpressionAttributeValues: {
          ':pk': 'TRAINING#STATUS',
          ':status': `${status}#`
        }
      };
    }
    // Filter by category if provided
    else if (category) {
      params = {
        TableName: TRAININGS_TABLE,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :pk AND begins_with(GSI2SK, :category)',
        ExpressionAttributeValues: {
          ':pk': 'TRAINING#CATEGORY',
          ':category': `${category}#`
        }
      };
    }
    // Default query - get all trainings
    else {
      params = {
        TableName: TRAININGS_TABLE,
        KeyConditionExpression: 'begins_with(PK, :pk) AND SK = :sk',
        ExpressionAttributeValues: {
          ':pk': 'TRAINING#',
          ':sk': 'INFO'
        }
      };
    }
    
    // Add filters for time-based queries
    const now = new Date().toISOString();
    if (upcoming === 'true') {
      params.FilterExpression = 'startDate > :now';
      params.ExpressionAttributeValues[':now'] = now;
    } else if (past === 'true') {
      params.FilterExpression = 'endDate < :now';
      params.ExpressionAttributeValues[':now'] = now;
    }
    
    // Add type filter if provided
    if (type) {
      const typeFilter = 'training_type = :type';
      params.FilterExpression = params.FilterExpression 
        ? `${params.FilterExpression} AND ${typeFilter}`
        : typeFilter;
      params.ExpressionAttributeValues[':type'] = type;
    }
    
    // Apply limit if provided
    if (limit && !isNaN(parseInt(limit))) {
      params.Limit = parseInt(limit);
    }
    
    const result = await dynamodb.query(params).promise();
    let trainings = result.Items || [];
    
    // If user is looking for required trainings only
    if (required === 'true') {
      // Filter trainings that are required for the user's department or role
      trainings = trainings.filter(training => {
        if (!training.requiredFor || training.requiredFor.length === 0) {
          return false;
        }
        
        return training.requiredFor.some(requirement => {
          if (requirement.type === 'department' && requirement.value === currentUser.department) {
            return true;
          }
          if (requirement.type === 'role' && requirement.value === currentUser.role) {
            return true;
          }
          return false;
        });
      });
    }
    
    // For each training, check if the user is enrolled
    const enrichedTrainings = await Promise.all(trainings.map(async (training) => {
      try {
        // Check if the user is enrolled in this training
        const enrollmentParams = {
          TableName: TRAININGS_TABLE,
          Key: {
            PK: `TRAINING#${training.trainingId}`,
            SK: `ENROLLMENT#${currentUser.id}`
          }
        };
        
        const enrollmentResult = await dynamodb.get(enrollmentParams).promise();
        
        return {
          ...training,
          isEnrolled: !!enrollmentResult.Item,
          enrollmentStatus: enrollmentResult.Item?.status || null,
          completionStatus: enrollmentResult.Item?.completionStatus || null
        };
      } catch (error) {
        console.error(`Error checking enrollment for training ${training.trainingId}:`, error);
        return training;
      }
    }));
    
    return res.status(200).json({
      message: 'Training programs retrieved successfully',
      trainings: enrichedTrainings
    });
  } catch (error) {
    console.error('Error retrieving training programs:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// GET /trainings/:id - Get a specific training program
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const trainingId = req.params.id;
    const currentUser = req.user;
    
    const params = {
      TableName: TRAININGS_TABLE,
      Key: {
        PK: `TRAINING#${trainingId}`,
        SK: 'INFO'
      }
    };
    
    const result = await dynamodb.get(params).promise();
    
    if (!result.Item) {
      return res.status(404).json({ message: 'Training program not found' });
    }
    
    // Check if user is enrolled in this training
    const enrollmentParams = {
      TableName: TRAININGS_TABLE,
      Key: {
        PK: `TRAINING#${trainingId}`,
        SK: `ENROLLMENT#${currentUser.id}`
      }
    };
    
    const enrollmentResult = await dynamodb.get(enrollmentParams).promise();
    
    // Check if user has completed this training (if enrolled)
    const completionStatus = enrollmentResult.Item?.completionStatus || null;
    
    // Check if user has access to the materials
    const hasAccessToMaterials = !!enrollmentResult.Item || 
                               currentUser.accessLevel >= 3 || 
                               result.Item.createdBy === currentUser.id;
    
    const training = {
      ...result.Item,
      isEnrolled: !!enrollmentResult.Item,
      enrollmentStatus: enrollmentResult.Item?.status || null,
      completionStatus,
      hasAccessToMaterials
    };
    
    // If the user has HR access or created the training, include enrollment list
    if (currentUser.accessLevel >= 3 || result.Item.createdBy === currentUser.id) {
      const enrollmentsParams = {
        TableName: TRAININGS_TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :enrollment)',
        ExpressionAttributeValues: {
          ':pk': `TRAINING#${trainingId}`,
          ':enrollment': 'ENROLLMENT#'
        }
      };
      
      const enrollmentsResult = await dynamodb.query(enrollmentsParams).promise();
      training.enrollments = enrollmentsResult.Items || [];
    }
    
    return res.status(200).json({
      message: 'Training program retrieved successfully',
      training
    });
  } catch (error) {
    console.error('Error retrieving training program:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// PUT /trainings/:id - Update a training program (HR & Managers)
router.put('/:id', verifyToken, checkAccess(3), authorizeFeature('training.manage'), async (req, res) => {
  try {
    const trainingId = req.params.id;
    const {
      title,
      description,
      type,
      category,
      startDate,
      endDate,
      location,
      instructor,
      maxParticipants,
      requiredFor,
      skills,
      materials,
      status
    } = req.body;
    
    // Check if training exists
    const getParams = {
      TableName: TRAININGS_TABLE,
      Key: {
        PK: `TRAINING#${trainingId}`,
        SK: 'INFO'
      }
    };
    
    const currentTraining = await dynamodb.get(getParams).promise();
    
    if (!currentTraining.Item) {
      return res.status(404).json({ message: 'Training program not found' });
    }
    
    // Check if user is authorized to update this training
    if (currentTraining.Item.createdBy !== req.user.id && req.user.accessLevel < 4) {
      return res.status(403).json({ message: 'Not authorized to update this training program' });
    }
    
    // Build update expression
    const updateExpressions = [];
    const expressionAttributeValues = {};
    const expressionAttributeNames = {};
    
    if (title) {
      updateExpressions.push('#title = :title');
      expressionAttributeNames['#title'] = 'title';
      expressionAttributeValues[':title'] = title;
    }
    
    if (description) {
      updateExpressions.push('description = :description');
      expressionAttributeValues[':description'] = description;
    }
    
    if (type) {
      updateExpressions.push('#type = :type');
      expressionAttributeNames['#type'] = 'type';
      expressionAttributeValues[':type'] = type;
    }
    
    if (category) {
      updateExpressions.push('category = :category');
      expressionAttributeValues[':category'] = category;
      
      // Update GSI2SK if category changes
      updateExpressions.push('GSI2SK = :gsi2sk');
      const startDateVal = startDate 
        ? moment(startDate).toISOString() 
        : currentTraining.Item.startDate;
      expressionAttributeValues[':gsi2sk'] = `${category}#${startDateVal}`;
    }
    
    if (startDate) {
      const formattedStartDate = moment(startDate).toISOString();
      updateExpressions.push('startDate = :startDate');
      expressionAttributeValues[':startDate'] = formattedStartDate;
      
      // Update GSIs with new start date
      if (status) {
        updateExpressions.push('GSI1SK = :gsi1sk');
        expressionAttributeValues[':gsi1sk'] = `${status}#${formattedStartDate}`;
      } else if (currentTraining.Item.status) {
        updateExpressions.push('GSI1SK = :gsi1sk');
        expressionAttributeValues[':gsi1sk'] = `${currentTraining.Item.status}#${formattedStartDate}`;
      }
      
      if (category) {
        // Already updated above if category changed
      } else if (currentTraining.Item.category) {
        updateExpressions.push('GSI2SK = :gsi2sk');
        expressionAttributeValues[':gsi2sk'] = `${currentTraining.Item.category}#${formattedStartDate}`;
      }
    }
    
    if (endDate) {
      updateExpressions.push('endDate = :endDate');
      expressionAttributeValues[':endDate'] = moment(endDate).toISOString();
    }
    
    if (location) {
      updateExpressions.push('location = :location');
      expressionAttributeValues[':location'] = location;
    }
    
    if (instructor) {
      updateExpressions.push('instructor = :instructor');
      expressionAttributeValues[':instructor'] = instructor;
    }
    
    if (maxParticipants !== undefined) {
      updateExpressions.push('maxParticipants = :maxParticipants');
      expressionAttributeValues[':maxParticipants'] = maxParticipants;
    }
    
    if (requiredFor) {
      updateExpressions.push('requiredFor = :requiredFor');
      expressionAttributeValues[':requiredFor'] = requiredFor;
    }
    
    if (skills) {
      updateExpressions.push('skills = :skills');
      expressionAttributeValues[':skills'] = skills;
    }
    
    if (materials) {
      updateExpressions.push('materials = :materials');
      expressionAttributeValues[':materials'] = materials;
    }
    
    if (status) {
      updateExpressions.push('#status = :status');
      expressionAttributeNames['#status'] = 'status';
      expressionAttributeValues[':status'] = status;
      
      // Update GSI1SK if status changes
      if (!startDate) {
        // Only update if startDate wasn't already updated above
        updateExpressions.push('GSI1SK = :gsi1sk');
        expressionAttributeValues[':gsi1sk'] = `${status}#${currentTraining.Item.startDate}`;
      }
    }
    
    // Always update these fields
    updateExpressions.push('updatedAt = :updatedAt');
    expressionAttributeValues[':updatedAt'] = new Date().toISOString();
    
    updateExpressions.push('updatedBy = :updatedBy');
    expressionAttributeValues[':updatedBy'] = req.user.id;
    
    updateExpressions.push('updatedByName = :updatedByName');
    expressionAttributeValues[':updatedByName'] = req.user.name;
    
    if (updateExpressions.length === 0) {
      return res.status(400).json({ message: 'No fields to update' });
    }
    
    const updateParams = {
      TableName: TRAININGS_TABLE,
      Key: {
        PK: `TRAINING#${trainingId}`,
        SK: 'INFO'
      },
      UpdateExpression: `SET ${updateExpressions.join(', ')}`,
      ExpressionAttributeValues: expressionAttributeValues,
      ExpressionAttributeNames: Object.keys(expressionAttributeNames).length > 0 ? expressionAttributeNames : undefined,
      ReturnValues: 'ALL_NEW'
    };
    
    const result = await dynamodb.update(updateParams).promise();
    
    // If status changed to cancelled, update enrollments
    if (status === 'cancelled' && currentTraining.Item.status !== 'cancelled') {
      // Get all enrollments
      const enrollmentsParams = {
        TableName: TRAININGS_TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :enrollment)',
        ExpressionAttributeValues: {
          ':pk': `TRAINING#${trainingId}`,
          ':enrollment': 'ENROLLMENT#'
        }
      };
      
      const enrollmentsResult = await dynamodb.query(enrollmentsParams).promise();
      
      // Update each enrollment to cancelled status
      if (enrollmentsResult.Items && enrollmentsResult.Items.length > 0) {
        const timestamp = new Date().toISOString();
        
        for (const enrollment of enrollmentsResult.Items) {
          const updateEnrollmentParams = {
            TableName: TRAININGS_TABLE,
            Key: {
              PK: enrollment.PK,
              SK: enrollment.SK
            },
            UpdateExpression: 'SET #status = :cancelled, updatedAt = :timestamp, notes = list_append(if_not_exists(notes, :empty_list), :note)',
            ExpressionAttributeNames: {
              '#status': 'status'
            },
            ExpressionAttributeValues: {
              ':cancelled': 'cancelled',
              ':timestamp': timestamp,
              ':empty_list': [],
              ':note': [{
                text: 'Training was cancelled by the organizer',
                timestamp,
                addedBy: req.user.id,
                addedByName: req.user.name
              }]
            }
          };
          
          await dynamodb.update(updateEnrollmentParams).promise();
        }
      }
    }
    
    return res.status(200).json({
      message: 'Training program updated successfully',
      training: result.Attributes
    });
  } catch (error) {
    console.error('Error updating training program:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// DELETE /trainings/:id - Delete/cancel a training program (HR & Admins)
router.delete('/:id', verifyToken, checkAccess(4), authorizeFeature('training.manage'), async (req, res) => {
  try {
    const trainingId = req.params.id;
    const { permanently } = req.query;
    
    // Check if training exists
    const getParams = {
      TableName: TRAININGS_TABLE,
      Key: {
        PK: `TRAINING#${trainingId}`,
        SK: 'INFO'
      }
    };
    
    const currentTraining = await dynamodb.get(getParams).promise();
    
    if (!currentTraining.Item) {
      return res.status(404).json({ message: 'Training program not found' });
    }
    
    // Only admins (level 5) can permanently delete
    if (permanently === 'true' && req.user.accessLevel < 5) {
      return res.status(403).json({ message: 'Not authorized to permanently delete training programs' });
    }
    
    if (permanently === 'true') {
      // Permanently delete the training and all enrollments
      
      // First, get all items related to this training
      const queryParams = {
        TableName: TRAININGS_TABLE,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: {
          ':pk': `TRAINING#${trainingId}`
        }
      };
      
      const queryResult = await dynamodb.query(queryParams).promise();
      
      // Delete each item
      if (queryResult.Items && queryResult.Items.length > 0) {
        for (const item of queryResult.Items) {
          const deleteParams = {
            TableName: TRAININGS_TABLE,
            Key: {
              PK: item.PK,
              SK: item.SK
            }
          };
          
          await dynamodb.delete(deleteParams).promise();
        }
      }
      
      return res.status(200).json({
        message: 'Training program permanently deleted'
      });
    } else {
      // Just mark as cancelled
      const timestamp = new Date().toISOString();
      const updateParams = {
        TableName: TRAININGS_TABLE,
        Key: {
          PK: `TRAINING#${trainingId}`,
          SK: 'INFO'
        },
        UpdateExpression: 'SET #status = :cancelled, updatedAt = :timestamp, updatedBy = :updatedBy, updatedByName = :updatedByName, GSI1SK = :gsi1sk',
        ExpressionAttributeNames: {
          '#status': 'status'
        },
        ExpressionAttributeValues: {
          ':cancelled': 'cancelled',
          ':timestamp': timestamp,
          ':updatedBy': req.user.id,
          ':updatedByName': req.user.name,
          ':gsi1sk': `cancelled#${currentTraining.Item.startDate}`
        },
        ReturnValues: 'ALL_NEW'
      };
      
      const result = await dynamodb.update(updateParams).promise();
      
      // Also update all enrollments to cancelled
      const enrollmentsParams = {
        TableName: TRAININGS_TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :enrollment)',
        ExpressionAttributeValues: {
          ':pk': `TRAINING#${trainingId}`,
          ':enrollment': 'ENROLLMENT#'
        }
      };
      
      const enrollmentsResult = await dynamodb.query(enrollmentsParams).promise();
      
      if (enrollmentsResult.Items && enrollmentsResult.Items.length > 0) {
        for (const enrollment of enrollmentsResult.Items) {
          const updateEnrollmentParams = {
            TableName: TRAININGS_TABLE,
            Key: {
              PK: enrollment.PK,
              SK: enrollment.SK
            },
            UpdateExpression: 'SET #status = :cancelled, updatedAt = :timestamp, notes = list_append(if_not_exists(notes, :empty_list), :note)',
            ExpressionAttributeNames: {
              '#status': 'status'
            },
            ExpressionAttributeValues: {
              ':cancelled': 'cancelled',
              ':timestamp': timestamp,
              ':empty_list': [],
              ':note': [{
                text: 'Training was cancelled by the organizer',
                timestamp,
                addedBy: req.user.id,
                addedByName: req.user.name
              }]
            }
          };
          
          await dynamodb.update(updateEnrollmentParams).promise();
        }
      }
      
      return res.status(200).json({
        message: 'Training program cancelled successfully',
        training: result.Attributes
      });
    }
  } catch (error) {
    console.error('Error deleting/cancelling training program:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// POST /trainings/:id/enroll - Enroll in a training program
router.post('/:id/enroll', verifyToken, async (req, res) => {
  try {
    const trainingId = req.params.id;
    const employeeId = req.user.id;
    
    // Check if training exists
    const trainingParams = {
      TableName: TRAININGS_TABLE,
      Key: {
        PK: `TRAINING#${trainingId}`,
        SK: 'INFO'
      }
    };
    
    const trainingResult = await dynamodb.get(trainingParams).promise();
    
    if (!trainingResult.Item) {
      return res.status(404).json({ message: 'Training program not found' });
    }
    
    const training = trainingResult.Item;
    
    // Check if training is available for enrollment
    if (training.status !== 'scheduled' && training.status !== 'in-progress') {
      return res.status(400).json({ 
        message: `Cannot enroll in a training with status: ${training.status}` 
      });
    }
    
    // Check if already enrolled
    const enrollmentCheckParams = {
      TableName: TRAININGS_TABLE,
      Key: {
        PK: `TRAINING#${trainingId}`,
        SK: `ENROLLMENT#${employeeId}`
      }
    };
    
    const enrollmentCheck = await dynamodb.get(enrollmentCheckParams).promise();
    
    if (enrollmentCheck.Item) {
      return res.status(400).json({ message: 'Already enrolled in this training program' });
    }
    
    // Check if maximum participants reached
    if (training.maxParticipants && training.currentParticipants >= training.maxParticipants) {
      return res.status(400).json({ message: 'Maximum participants reached for this training' });
    }
    
    const timestamp = new Date().toISOString();
    
    // Create enrollment record
    const enrollmentParams = {
      TableName: TRAININGS_TABLE,
      Item: {
        PK: `TRAINING#${trainingId}`,
        SK: `ENROLLMENT#${employeeId}`,
        trainingId,
        employeeId,
        employeeName: req.user.name,
        employeeDepartment: req.user.department,
        employeePosition: req.user.position,
        status: 'enrolled',
        completionStatus: null,
        enrolledAt: timestamp,
        updatedAt: timestamp,
        GSI1PK: `EMPLOYEE#${employeeId}`,
        GSI1SK: `TRAINING#${timestamp}`
      }
    };
    
    await dynamodb.put(enrollmentParams).promise();
    
    // Update training to increment participant count
    const updateTrainingParams = {
      TableName: TRAININGS_TABLE,
      Key: {
        PK: `TRAINING#${trainingId}`,
        SK: 'INFO'
      },
      UpdateExpression: 'SET currentParticipants = currentParticipants + :one',
      ExpressionAttributeValues: {
        ':one': 1
      },
      ReturnValues: 'ALL_NEW'
    };
    
    const updatedTraining = await dynamodb.update(updateTrainingParams).promise();
    
    return res.status(200).json({
      message: 'Successfully enrolled in training program',
      enrollment: enrollmentParams.Item,
      training: updatedTraining.Attributes
    });
  } catch (error) {
    console.error('Error enrolling in training program:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// POST /trainings/:id/unenroll - Unenroll from a training program
router.post('/:id/unenroll', verifyToken, async (req, res) => {
  try {
    const trainingId = req.params.id;
    const employeeId = req.user.id;
    
    // Check if enrollment exists
    const enrollmentParams = {
      TableName: TRAININGS_TABLE,
      Key: {
        PK: `TRAINING#${trainingId}`,
        SK: `ENROLLMENT#${employeeId}`
      }
    };
    
    const enrollmentResult = await dynamodb.get(enrollmentParams).promise();
    
    if (!enrollmentResult.Item) {
      return res.status(404).json({ message: 'Not enrolled in this training program' });
    }
    
    // Check if training allows unenrollment
    const trainingParams = {
      TableName: TRAININGS_TABLE,
      Key: {
        PK: `TRAINING#${trainingId}`,
        SK: 'INFO'
      }
    };
    
    const trainingResult = await dynamodb.get(trainingParams).promise();
    
    if (!trainingResult.Item) {
      return res.status(404).json({ message: 'Training program not found' });
    }
    
    const training = trainingResult.Item;
    
    // Check if training already started
    const now = new Date();
    const startDate = new Date(training.startDate);
    
    if (now > startDate) {
      return res.status(400).json({ message: 'Cannot unenroll from a training that has already started' });
    }
    
    // Delete enrollment
    await dynamodb.delete(enrollmentParams).promise();
    
    // Update training to decrement participant count
    const updateTrainingParams = {
      TableName: TRAININGS_TABLE,
      Key: {
        PK: `TRAINING#${trainingId}`,
        SK: 'INFO'
      },
      UpdateExpression: 'SET currentParticipants = currentParticipants - :one',
      ExpressionAttributeValues: {
        ':one': 1
      },
      ReturnValues: 'ALL_NEW'
    };
    
    const updatedTraining = await dynamodb.update(updateTrainingParams).promise();
    
    return res.status(200).json({
      message: 'Successfully unenrolled from training program',
      training: updatedTraining.Attributes
    });
  } catch (error) {
    console.error('Error unenrolling from training program:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// POST /trainings/:id/complete - Mark a training as completed (for enrolled employee)
router.post('/:id/complete', verifyToken, async (req, res) => {
  try {
    const trainingId = req.params.id;
    const employeeId = req.user.id;
    const { feedback, rating } = req.body;
    
    // Check if enrollment exists
    const enrollmentParams = {
      TableName: TRAININGS_TABLE,
      Key: {
        PK: `TRAINING#${trainingId}`,
        SK: `ENROLLMENT#${employeeId}`
      }
    };
    
    const enrollmentResult = await dynamodb.get(enrollmentParams).promise();
    
    if (!enrollmentResult.Item) {
      return res.status(404).json({ message: 'Not enrolled in this training program' });
    }
    
    const enrollment = enrollmentResult.Item;
    
    // Check if already completed
    if (enrollment.completionStatus === 'completed') {
      return res.status(400).json({ message: 'Training already marked as completed' });
    }
    
    const timestamp = new Date().toISOString();
    
    // Update enrollment to completed status
    const updateParams = {
      TableName: TRAININGS_TABLE,
      Key: {
        PK: `TRAINING#${trainingId}`,
        SK: `ENROLLMENT#${employeeId}`
      },
      UpdateExpression: 'SET completionStatus = :completed, completedAt = :timestamp, updatedAt = :timestamp, feedback = :feedback, rating = :rating',
      ExpressionAttributeValues: {
        ':completed': 'completed',
        ':timestamp': timestamp,
        ':feedback': feedback || null,
        ':rating': rating || null
      },
      ReturnValues: 'ALL_NEW'
    };
    
    const result = await dynamodb.update(updateParams).promise();
    
    // Add completion record to employee profile
    const employeeTrainingParams = {
      TableName: EMPLOYEES_TABLE,
      Item: {
        PK: `EMPLOYEE#${employeeId}`,
        SK: `TRAINING#${trainingId}`,
        trainingId,
        trainingTitle: enrollmentResult.Item.trainingTitle || 'Unknown Training',
        completedAt: timestamp,
        expiresAt: null, // Some trainings might have expiration dates
        certificationId: null // Some trainings might provide certifications
      }
    };
    
    await dynamodb.put(employeeTrainingParams).promise();
    
    return res.status(200).json({
      message: 'Training marked as completed successfully',
      enrollment: result.Attributes
    });
  } catch (error) {
    console.error('Error marking training as completed:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// POST /trainings/:id/material - Add material to a training (HR & Managers)
router.post('/:id/material', verifyToken, checkAccess(3), async (req, res) => {
  try {
    const trainingId = req.params.id;
    const { title, description, type, content, fileContent, fileName, contentType } = req.body;
    
    // Check if training exists
    const trainingParams = {
      TableName: TRAININGS_TABLE,
      Key: {
        PK: `TRAINING#${trainingId}`,
        SK: 'INFO'
      }
    };
    
    const trainingResult = await dynamodb.get(trainingParams).promise();
    
    if (!trainingResult.Item) {
      return res.status(404).json({ message: 'Training program not found' });
    }
    
    // Validate required fields
    if (!title || !type) {
      return res.status(400).json({ message: 'Title and type are required' });
    }
    
    let materialUrl = null;
    
    // If file upload is included, process it
    if (fileContent && fileName && contentType) {
      // Convert base64 to buffer
      const fileBuffer = Buffer.from(fileContent, 'base64');
      
      // Upload to S3
      const s3Key = `trainings/${trainingId}/materials/${fileName}`;
      const s3Params = {
        Bucket: DOCUMENT_BUCKET,
        Key: s3Key,
        Body: fileBuffer,
        ContentType: contentType,
        ACL: 'private'
      };
      
      const s3Result = await s3.upload(s3Params).promise();
      materialUrl = s3Result.Location;
    }
    
    const materialId = uuidv4();
    const timestamp = new Date().toISOString();
    
    const materialParams = {
      TableName: TRAININGS_TABLE,
      Item: {
        PK: `TRAINING#${trainingId}`,
        SK: `MATERIAL#${materialId}`,
        materialId,
        trainingId,
        title,
        description: description || null,
        type,
        content: content || null,
        url: materialUrl,
        fileName: fileName || null,
        contentType: contentType || null,
        createdBy: req.user.id,
        createdByName: req.user.name,
        createdAt: timestamp,
        updatedAt: timestamp
      }
    };
    
    await dynamodb.put(materialParams).promise();
    
    // Update the training's materials list
    const updateTrainingParams = {
      TableName: TRAININGS_TABLE,
      Key: {
        PK: `TRAINING#${trainingId}`,
        SK: 'INFO'
      },
      UpdateExpression: 'SET materials = list_append(if_not_exists(materials, :empty_list), :material)',
      ExpressionAttributeValues: {
        ':material': [{
          materialId,
          title,
          type,
          url: materialUrl,
          fileName: fileName || null
        }],
        ':empty_list': []
      },
      ReturnValues: 'ALL_NEW'
    };
    
    const updatedTraining = await dynamodb.update(updateTrainingParams).promise();
    
    return res.status(201).json({
      message: 'Training material added successfully',
      material: materialParams.Item,
      training: updatedTraining.Attributes
    });
  } catch (error) {
    console.error('Error adding training material:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// GET /trainings/employee/:id - Get all trainings for a specific employee (HR & Managers)
router.get('/employee/:id', verifyToken, checkAccess(3), async (req, res) => {
  try {
    const employeeId = req.params.id;
    
    // First verify employee exists
    const employeeParams = {
      TableName: EMPLOYEES_TABLE,
      Key: {
        PK: `EMPLOYEE#${employeeId}`,
        SK: 'PROFILE'
      }
    };
    
    const employeeResult = await dynamodb.get(employeeParams).promise();
    
    if (!employeeResult.Item) {
      return res.status(404).json({ message: 'Employee not found' });
    }
    
    // Get all training enrollments for this employee
    const enrollmentsParams = {
      TableName: TRAININGS_TABLE,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: {
        ':pk': `EMPLOYEE#${employeeId}`
      }
    };
    
    const enrollmentsResult = await dynamodb.query(enrollmentsParams).promise();
    const enrollments = enrollmentsResult.Items || [];
    
    // Get details for each training
    const trainingDetails = [];
    
    for (const enrollment of enrollments) {
      const trainingId = enrollment.trainingId;
      
      const trainingParams = {
        TableName: TRAININGS_TABLE,
        Key: {
          PK: `TRAINING#${trainingId}`,
          SK: 'INFO'
        }
      };
      
      const trainingResult = await dynamodb.get(trainingParams).promise();
      
      if (trainingResult.Item) {
        trainingDetails.push({
          training: trainingResult.Item,
          enrollment
        });
      }
    }
    
    return res.status(200).json({
      message: 'Employee trainings retrieved successfully',
      trainings: trainingDetails,
      employeeName: employeeResult.Item.name
    });
  } catch (error) {
    console.error('Error retrieving employee trainings:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// GET /trainings/my - Get all trainings for the current employee
router.get('/my/list', verifyToken, async (req, res) => {
  try {
    const employeeId = req.user.id;
    const { status } = req.query;
    
    // Get all training enrollments for this employee
    const enrollmentsParams = {
      TableName: TRAININGS_TABLE,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: {
        ':pk': `EMPLOYEE#${employeeId}`
      }
    };
    
    const enrollmentsResult = await dynamodb.query(enrollmentsParams).promise();
    let enrollments = enrollmentsResult.Items || [];
    
    // Filter by status if requested
    if (status) {
      enrollments = enrollments.filter(enrollment => 
        enrollment.status === status || enrollment.completionStatus === status
      );
    }
    
    // Get details for each training
    const trainingDetails = [];
    
    for (const enrollment of enrollments) {
      const trainingId = enrollment.trainingId;
      
      const trainingParams = {
        TableName: TRAININGS_TABLE,
        Key: {
          PK: `TRAINING#${trainingId}`,
          SK: 'INFO'
        }
      };
      
      const trainingResult = await dynamodb.get(trainingParams).promise();
      
      if (trainingResult.Item) {
        trainingDetails.push({
          training: trainingResult.Item,
          enrollment
        });
      }
    }
    
    return res.status(200).json({
      message: 'Your trainings retrieved successfully',
      trainings: trainingDetails
    });
  } catch (error) {
    console.error('Error retrieving your trainings:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// GET /trainings/categories - Get list of training categories
router.get('/categories/list', verifyToken, async (req, res) => {
  try {
    // These are predefined categories in the system
    const categories = [
      {
        id: 'onboarding',
        name: 'Onboarding',
        description: 'Training for new employees'
      },
      {
        id: 'compliance',
        name: 'Compliance',
        description: 'Mandatory regulatory and policy compliance training'
      },
      {
        id: 'technical',
        name: 'Technical Skills',
        description: 'Technical and job-specific skills training'
      },
      {
        id: 'soft-skills',
        name: 'Soft Skills',
        description: 'Communication, leadership, and interpersonal skills training'
      },
      {
        id: 'safety',
        name: 'Safety & Security',
        description: 'Workplace safety and security protocols'
      },
      {
        id: 'professional',
        name: 'Professional Development',
        description: 'Career growth and professional skills'
      },
      {
        id: 'management',
        name: 'Management & Leadership',
        description: 'Training for managers and leadership roles'
      },
      {
        id: 'other',
        name: 'Other',
        description: 'Miscellaneous training programs'
      }
    ];
    
    return res.status(200).json({
      message: 'Training categories retrieved successfully',
      categories
    });
  } catch (error) {
    console.error('Error retrieving training categories:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

module.exports = router;

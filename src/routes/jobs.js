const express = require('express');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');
const checkAccess = require('../middleware/checkAccess');
const AWS = require('aws-sdk');
const { v4: uuidv4 } = require('uuid');

const dynamodb = new AWS.DynamoDB.DocumentClient();
const JOBS_TABLE = process.env.JOBS_TABLE;

// POST /jobs - Create a new job posting (HR only)
router.post('/', verifyToken, checkAccess(4), async (req, res) => {
  try {
    const {
      title,
      department,
      description,
      requirements,
      salary,
      location,
      type, // full-time, part-time, contract
      status, // open, closed, draft
      applicationDeadline
    } = req.body;
    
    const jobId = uuidv4();
    const timestamp = new Date().toISOString();
    
    const newJob = {
      PK: `JOB#${jobId}`,
      SK: 'DETAILS',
      jobId,
      title,
      department,
      description,
      requirements,
      salary,
      location,
      type,
      status: status || 'draft',
      applicationDeadline,
      createdAt: timestamp,
      updatedAt: timestamp,
      createdBy: req.user.id,
      createdByName: req.user.name,
      applicantCount: 0,
      GSI1PK: `JOB#DEPARTMENT#${department}`,
      GSI1SK: `STATUS#${status || 'draft'}#${timestamp}`,
      GSI2PK: `JOB#STATUS#${status || 'draft'}`,
      GSI2SK: `${timestamp}`
    };
    
    await dynamodb.put({
      TableName: JOBS_TABLE,
      Item: newJob
    }).promise();
    
    return res.status(201).json({
      message: 'Job posting created successfully',
      job: newJob
    });
  } catch (error) {
    console.error('Error creating job posting:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// GET /jobs - Get all job postings
router.get('/', verifyToken, async (req, res) => {
  try {
    const { department, status, type } = req.query;
    
    let params = {};
    
    if (department) {
      // Query by department
      params = {
        TableName: JOBS_TABLE,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :dept',
        ExpressionAttributeValues: {
          ':dept': `JOB#DEPARTMENT#${department}`
        }
      };
      
      if (status) {
        params.KeyConditionExpression += ' AND begins_with(GSI1SK, :status)';
        params.ExpressionAttributeValues[':status'] = `STATUS#${status}`;
      }
    } else if (status) {
      // Query by status
      params = {
        TableName: JOBS_TABLE,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :status',
        ExpressionAttributeValues: {
          ':status': `JOB#STATUS#${status}`
        }
      };
    } else {
      // Get all jobs
      params = {
        TableName: JOBS_TABLE,
        FilterExpression: 'SK = :details',
        ExpressionAttributeValues: {
          ':details': 'DETAILS'
        }
      };
    }
    
    // Add type filter if specified
    if (type && !params.FilterExpression) {
      params.FilterExpression = '#type = :type';
      params.ExpressionAttributeNames = { '#type': 'type' };
      params.ExpressionAttributeValues[':type'] = type;
    } else if (type) {
      params.FilterExpression += ' AND #type = :type';
      if (!params.ExpressionAttributeNames) {
        params.ExpressionAttributeNames = {};
      }
      params.ExpressionAttributeNames['#type'] = 'type';
      params.ExpressionAttributeValues[':type'] = type;
    }
    
    let result;
    if (params.KeyConditionExpression) {
      result = await dynamodb.query(params).promise();
    } else {
      result = await dynamodb.scan(params).promise();
    }
    
    // For non-HR users, filter out draft jobs
    if (req.user.accessLevel < 4) {
      result.Items = result.Items.filter(job => job.status !== 'draft');
    }
    
    return res.status(200).json({
      message: 'Job postings retrieved successfully',
      jobs: result.Items
    });
  } catch (error) {
    console.error('Error retrieving job postings:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// GET /jobs/:id - Get a specific job posting
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const jobId = req.params.id;
    
    const params = {
      TableName: JOBS_TABLE,
      Key: {
        PK: `JOB#${jobId}`,
        SK: 'DETAILS'
      }
    };
    
    const result = await dynamodb.get(params).promise();
    
    if (!result.Item) {
      return res.status(404).json({ message: 'Job posting not found' });
    }
    
    // Check if non-HR trying to access draft job
    if (req.user.accessLevel < 4 && result.Item.status === 'draft') {
      return res.status(403).json({ message: 'Unauthorized to access this job posting' });
    }
    
    return res.status(200).json({
      message: 'Job posting retrieved successfully',
      job: result.Item
    });
  } catch (error) {
    console.error('Error retrieving job posting:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// PUT /jobs/:id - Update a job posting (HR only)
router.put('/:id', verifyToken, checkAccess(4), async (req, res) => {
  try {
    const jobId = req.params.id;
    const {
      title,
      department,
      description,
      requirements,
      salary,
      location,
      type,
      status,
      applicationDeadline
    } = req.body;
    
    // Check if job exists
    const getParams = {
      TableName: JOBS_TABLE,
      Key: {
        PK: `JOB#${jobId}`,
        SK: 'DETAILS'
      }
    };
    
    const existingJob = await dynamodb.get(getParams).promise();
    
    if (!existingJob.Item) {
      return res.status(404).json({ message: 'Job posting not found' });
    }
    
    const timestamp = new Date().toISOString();
    const updateExpressions = [];
    const expressionAttributeNames = {};
    const expressionAttributeValues = {};
    
    if (title) {
      updateExpressions.push('#title = :title');
      expressionAttributeNames['#title'] = 'title';
      expressionAttributeValues[':title'] = title;
    }
    
    if (description) {
      updateExpressions.push('#description = :description');
      expressionAttributeNames['#description'] = 'description';
      expressionAttributeValues[':description'] = description;
    }
    
    if (requirements) {
      updateExpressions.push('#requirements = :requirements');
      expressionAttributeNames['#requirements'] = 'requirements';
      expressionAttributeValues[':requirements'] = requirements;
    }
    
    if (salary) {
      updateExpressions.push('#salary = :salary');
      expressionAttributeNames['#salary'] = 'salary';
      expressionAttributeValues[':salary'] = salary;
    }
    
    if (location) {
      updateExpressions.push('#location = :location');
      expressionAttributeNames['#location'] = 'location';
      expressionAttributeValues[':location'] = location;
    }
    
    if (type) {
      updateExpressions.push('#type = :type');
      expressionAttributeNames['#type'] = 'type';
      expressionAttributeValues[':type'] = type;
    }
    
    if (applicationDeadline) {
      updateExpressions.push('#applicationDeadline = :applicationDeadline');
      expressionAttributeNames['#applicationDeadline'] = 'applicationDeadline';
      expressionAttributeValues[':applicationDeadline'] = applicationDeadline;
    }
    
    // Update department if changed (affects GSI)
    if (department && department !== existingJob.Item.department) {
      updateExpressions.push('#department = :department');
      expressionAttributeNames['#department'] = 'department';
      expressionAttributeValues[':department'] = department;
      
      // Update GSI1PK
      updateExpressions.push('GSI1PK = :gsi1pk');
      expressionAttributeValues[':gsi1pk'] = `JOB#DEPARTMENT#${department}`;
    }
    
    // Update status if changed (affects GSI)
    if (status && status !== existingJob.Item.status) {
      updateExpressions.push('#status = :status');
      expressionAttributeNames['#status'] = 'status';
      expressionAttributeValues[':status'] = status;
      
      // Update GSIs
      updateExpressions.push('GSI1SK = :gsi1sk');
      expressionAttributeValues[':gsi1sk'] = `STATUS#${status}#${existingJob.Item.createdAt}`;
      
      updateExpressions.push('GSI2PK = :gsi2pk');
      expressionAttributeValues[':gsi2pk'] = `JOB#STATUS#${status}`;
    }
    
    // Always update these fields
    updateExpressions.push('updatedAt = :updatedAt');
    expressionAttributeValues[':updatedAt'] = timestamp;
    
    updateExpressions.push('updatedBy = :updatedBy');
    expressionAttributeValues[':updatedBy'] = req.user.id;
    
    updateExpressions.push('updatedByName = :updatedByName');
    expressionAttributeValues[':updatedByName'] = req.user.name;
    
    if (updateExpressions.length === 0) {
      return res.status(400).json({ message: 'No fields to update' });
    }
    
    const updateParams = {
      TableName: JOBS_TABLE,
      Key: {
        PK: `JOB#${jobId}`,
        SK: 'DETAILS'
      },
      UpdateExpression: `SET ${updateExpressions.join(', ')}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW'
    };
    
    const updateResult = await dynamodb.update(updateParams).promise();
    
    return res.status(200).json({
      message: 'Job posting updated successfully',
      job: updateResult.Attributes
    });
  } catch (error) {
    console.error('Error updating job posting:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// POST /jobs/:id/apply - Apply for a job
router.post('/:id/apply', verifyToken, async (req, res) => {
  try {
    const jobId = req.params.id;
    const {
      applicantName,
      email,
      phone,
      resume,
      coverLetter,
      experience,
      skills,
      referredBy
    } = req.body;
    
    // Check if job exists and is open
    const getJobParams = {
      TableName: JOBS_TABLE,
      Key: {
        PK: `JOB#${jobId}`,
        SK: 'DETAILS'
      }
    };
    
    const jobResult = await dynamodb.get(getJobParams).promise();
    
    if (!jobResult.Item) {
      return res.status(404).json({ message: 'Job posting not found' });
    }
    
    if (jobResult.Item.status !== 'open') {
      return res.status(400).json({ message: 'This job is not accepting applications' });
    }
    
    // Check if application deadline has passed
    if (jobResult.Item.applicationDeadline) {
      const deadline = new Date(jobResult.Item.applicationDeadline);
      const now = new Date();
      
      if (now > deadline) {
        return res.status(400).json({ message: 'Application deadline has passed' });
      }
    }
    
    const applicationId = uuidv4();
    const timestamp = new Date().toISOString();
    
    // Create application record
    const newApplication = {
      PK: `JOB#${jobId}`,
      SK: `APPLICATION#${applicationId}`,
      jobId,
      applicationId,
      applicantName: applicantName || `${req.user.firstName} ${req.user.lastName}`,
      email: email || req.user.email,
      phone,
      resume,
      coverLetter,
      experience,
      skills,
      referredBy,
      status: 'submitted',
      submittedBy: req.user.id,
      createdAt: timestamp,
      updatedAt: timestamp,
      GSI1PK: `APPLICATION#${applicationId}`,
      GSI1SK: `JOB#${jobId}`,
      GSI2PK: `APPLICATION#STATUS#submitted`,
      GSI2SK: `${timestamp}`
    };
    
    await dynamodb.put({
      TableName: JOBS_TABLE,
      Item: newApplication
    }).promise();
    
    // Increment application count on job
    const updateJobParams = {
      TableName: JOBS_TABLE,
      Key: {
        PK: `JOB#${jobId}`,
        SK: 'DETAILS'
      },
      UpdateExpression: 'SET applicantCount = applicantCount + :inc',
      ExpressionAttributeValues: {
        ':inc': 1
      }
    };
    
    await dynamodb.update(updateJobParams).promise();
    
    return res.status(201).json({
      message: 'Application submitted successfully',
      application: newApplication
    });
  } catch (error) {
    console.error('Error submitting application:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// GET /jobs/:id/applications - Get all applications for a job (HR only)
router.get('/:id/applications', verifyToken, checkAccess(4), async (req, res) => {
  try {
    const jobId = req.params.id;
    const { status } = req.query;
    
    // Check if job exists
    const getJobParams = {
      TableName: JOBS_TABLE,
      Key: {
        PK: `JOB#${jobId}`,
        SK: 'DETAILS'
      }
    };
    
    const jobResult = await dynamodb.get(getJobParams).promise();
    
    if (!jobResult.Item) {
      return res.status(404).json({ message: 'Job posting not found' });
    }
    
    // Query applications for this job
    const params = {
      TableName: JOBS_TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': `JOB#${jobId}`,
        ':sk': 'APPLICATION#'
      }
    };
    
    // Add status filter if specified
    if (status) {
      params.FilterExpression = '#status = :status';
      params.ExpressionAttributeNames = { '#status': 'status' };
      params.ExpressionAttributeValues[':status'] = status;
    }
    
    const applicationsResult = await dynamodb.query(params).promise();
    
    return res.status(200).json({
      message: 'Applications retrieved successfully',
      jobTitle: jobResult.Item.title,
      applications: applicationsResult.Items
    });
  } catch (error) {
    console.error('Error retrieving applications:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// PUT /jobs/:id/applications/:applicationId - Update application status (HR only)
router.put('/:id/applications/:applicationId', verifyToken, checkAccess(4), async (req, res) => {
  try {
    const jobId = req.params.id;
    const applicationId = req.params.applicationId;
    const { status, feedback } = req.body;
    
    if (!status) {
      return res.status(400).json({ message: 'Status is required' });
    }
    
    // Validate status
    const validStatuses = ['submitted', 'reviewed', 'interview', 'offered', 'accepted', 'rejected', 'withdrawn'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }
    
    // Check if application exists
    const getParams = {
      TableName: JOBS_TABLE,
      Key: {
        PK: `JOB#${jobId}`,
        SK: `APPLICATION#${applicationId}`
      }
    };
    
    const applicationResult = await dynamodb.get(getParams).promise();
    
    if (!applicationResult.Item) {
      return res.status(404).json({ message: 'Application not found' });
    }
    
    const timestamp = new Date().toISOString();
    
    // Update application status
    const updateParams = {
      TableName: JOBS_TABLE,
      Key: {
        PK: `JOB#${jobId}`,
        SK: `APPLICATION#${applicationId}`
      },
      UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt, updatedBy = :updatedBy, feedback = :feedback, GSI2PK = :gsi2pk, GSI2SK = :gsi2sk',
      ExpressionAttributeNames: {
        '#status': 'status'
      },
      ExpressionAttributeValues: {
        ':status': status,
        ':updatedAt': timestamp,
        ':updatedBy': req.user.id,
        ':feedback': feedback || null,
        ':gsi2pk': `APPLICATION#STATUS#${status}`,
        ':gsi2sk': timestamp
      },
      ReturnValues: 'ALL_NEW'
    };
    
    const updateResult = await dynamodb.update(updateParams).promise();
    
    return res.status(200).json({
      message: 'Application status updated successfully',
      application: updateResult.Attributes
    });
  } catch (error) {
    console.error('Error updating application status:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// GET /jobs/applications/my - Get all applications submitted by current user
router.get('/applications/my', verifyToken, async (req, res) => {
  try {
    const employeeId = req.user.id;
    
    // Query applications submitted by this user
    const params = {
      TableName: JOBS_TABLE,
      FilterExpression: 'submittedBy = :employeeId',
      ExpressionAttributeValues: {
        ':employeeId': employeeId
      }
    };
    
    const result = await dynamodb.scan(params).promise();
    
    // Fetch job details for each application
    const applications = [];
    for (const app of result.Items) {
      const jobParams = {
        TableName: JOBS_TABLE,
        Key: {
          PK: `JOB#${app.jobId}`,
          SK: 'DETAILS'
        }
      };
      
      const jobResult = await dynamodb.get(jobParams).promise();
      
      if (jobResult.Item) {
        applications.push({
          ...app,
          jobTitle: jobResult.Item.title,
          department: jobResult.Item.department,
          location: jobResult.Item.location
        });
      } else {
        applications.push(app);
      }
    }
    
    return res.status(200).json({
      message: 'Applications retrieved successfully',
      applications
    });
  } catch (error) {
    console.error('Error retrieving user applications:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// DELETE /jobs/:id - Close a job posting (HR only)
router.delete('/:id', verifyToken, checkAccess(4), async (req, res) => {
  try {
    const jobId = req.params.id;
    
    // Check if job exists
    const getParams = {
      TableName: JOBS_TABLE,
      Key: {
        PK: `JOB#${jobId}`,
        SK: 'DETAILS'
      }
    };
    
    const existingJob = await dynamodb.get(getParams).promise();
    
    if (!existingJob.Item) {
      return res.status(404).json({ message: 'Job posting not found' });
    }
    
    // Update job status to closed instead of deleting
    const timestamp = new Date().toISOString();
    
    const updateParams = {
      TableName: JOBS_TABLE,
      Key: {
        PK: `JOB#${jobId}`,
        SK: 'DETAILS'
      },
      UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt, updatedBy = :updatedBy, updatedByName = :updatedByName, GSI1SK = :gsi1sk, GSI2PK = :gsi2pk',
      ExpressionAttributeNames: {
        '#status': 'status'
      },
      ExpressionAttributeValues: {
        ':status': 'closed',
        ':updatedAt': timestamp,
        ':updatedBy': req.user.id,
        ':updatedByName': req.user.name,
        ':gsi1sk': `STATUS#closed#${existingJob.Item.createdAt}`,
        ':gsi2pk': 'JOB#STATUS#closed'
      }
    };
    
    await dynamodb.update(updateParams).promise();
    
    return res.status(200).json({
      message: 'Job posting closed successfully'
    });
  } catch (error) {
    console.error('Error closing job posting:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

module.exports = router;

const express = require('express');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');
const checkAccess = require('../middleware/checkAccess');
const authorizeFeature = require('../middleware/authorizeFeature');
const AWS = require('aws-sdk');
const { v4: uuidv4 } = require('uuid');

const dynamodb = new AWS.DynamoDB.DocumentClient();
const ONBOARDING_TABLE = process.env.HRIS_ONBOARDING_TABLE || 'hris_onboarding';
const EMPLOYEES_TABLE = process.env.HRIS_EMPLOYEES_TABLE || 'hris_employees';
const REQUESTS_TABLE = process.env.HRIS_REQUESTS_TABLE || 'hris_requests';
const ASSETS_TABLE = process.env.HRIS_ASSETS_TABLE || 'hris_assets';

/**
 * POST /onboarding/start - HR initiates onboarding for a new employee
 */
router.post('/start', verifyToken, checkAccess(3), authorizeFeature('employee.onboarding'), async (req, res) => {
  try {
    const {
      employeeId,
      startDate,
      department,
      position,
      manager,
      checklist = [],
      notes
    } = req.body;
    
    // Validate required fields
    if (!employeeId || !startDate || !department) {
      return res.status(400).json({
        message: 'Employee ID, start date, and department are required'
      });
    }
    
    // Verify the employee exists
    const employeeParams = {
      TableName: EMPLOYEES_TABLE,
      Key: {
        PK: `EMPLOYEE#${employeeId}`,
        SK: 'PROFILE'
      }
    };
    
    const employeeResult = await dynamodb.get(employeeParams).promise();
    
    if (!employeeResult.Item) {
      return res.status(404).json({
        message: 'Employee not found'
      });
    }
    
    const onboardingId = uuidv4();
    const timestamp = new Date().toISOString();
    
    // Define default onboarding checklist if not provided
    let onboardingChecklist = checklist.length > 0 ? checklist : [
      {
        id: uuidv4(),
        title: 'Complete employee paperwork',
        category: 'HR',
        status: 'pending',
        assignedTo: req.user.id,
        dueDate: new Date(new Date(startDate).getTime() - 86400000).toISOString(), // 1 day before start
        completedDate: null
      },
      {
        id: uuidv4(),
        title: 'Set up workspace',
        category: 'Facilities',
        status: 'pending',
        assignedTo: null, // To be assigned
        dueDate: new Date(new Date(startDate).getTime() - 86400000).toISOString(), // 1 day before start
        completedDate: null
      },
      {
        id: uuidv4(),
        title: 'Prepare IT equipment',
        category: 'IT',
        status: 'pending',
        assignedTo: null, // To be assigned
        dueDate: new Date(new Date(startDate).getTime() - 86400000).toISOString(), // 1 day before start
        completedDate: null
      },
      {
        id: uuidv4(),
        title: 'Create accounts and set up access',
        category: 'IT',
        status: 'pending',
        assignedTo: null, // To be assigned
        dueDate: new Date(startDate),
        completedDate: null
      },
      {
        id: uuidv4(),
        title: 'Schedule orientation meeting',
        category: 'HR',
        status: 'pending',
        assignedTo: req.user.id,
        dueDate: new Date(startDate),
        completedDate: null
      },
      {
        id: uuidv4(),
        title: 'Assign training materials',
        category: 'Training',
        status: 'pending',
        assignedTo: manager || null,
        dueDate: new Date(new Date(startDate).getTime() + 86400000).toISOString(), // 1 day after start
        completedDate: null
      }
    ];
    
    const newOnboarding = {
      PK: `ONBOARDING#${onboardingId}`,
      SK: `EMPLOYEE#${employeeId}`,
      onboardingId,
      employeeId,
      employeeName: `${employeeResult.Item.firstName} ${employeeResult.Item.lastName}`,
      startDate,
      department,
      position,
      manager,
      status: 'in_progress',
      progress: 0,
      checklist: onboardingChecklist,
      createdBy: req.user.id,
      createdByName: req.user.name,
      createdAt: timestamp,
      updatedAt: timestamp,
      notes: notes || '',
      type: 'onboarding',
      GSI1PK: `EMPLOYEE#${employeeId}`,
      GSI1SK: `ONBOARDING#${timestamp}`,
      GSI2PK: 'ONBOARDING#STATUS',
      GSI2SK: `in_progress#${timestamp}`
    };
    
    await dynamodb.put({
      TableName: ONBOARDING_TABLE,
      Item: newOnboarding
    }).promise();
    
    // Create IT equipment request in the requests table
    const equipmentRequestId = uuidv4();
    const equipmentRequest = {
      PK: `REQUEST#${equipmentRequestId}`,
      SK: `EMPLOYEE#${employeeId}`,
      requestId: equipmentRequestId,
      employeeId,
      employeeName: `${employeeResult.Item.firstName} ${employeeResult.Item.lastName}`,
      employeeDepartment: department,
      type: 'equipment',
      title: 'New employee equipment setup',
      description: `Equipment setup for new employee starting on ${new Date(startDate).toLocaleDateString()}`,
      status: 'pending',
      createdAt: timestamp,
      updatedAt: timestamp,
      createdBy: req.user.id,
      createdByName: req.user.name,
      GSI1PK: `EMPLOYEE#${employeeId}`,
      GSI1SK: `REQUEST#equipment#${timestamp}`,
      GSI2PK: `REQUEST#equipment`,
      GSI2SK: `STATUS#pending#${timestamp}`
    };
    
    await dynamodb.put({
      TableName: REQUESTS_TABLE,
      Item: equipmentRequest
    }).promise();
    
    return res.status(201).json({
      message: 'Onboarding process initiated successfully',
      onboarding: newOnboarding,
      equipmentRequest
    });
  } catch (error) {
    console.error('Error initiating onboarding:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * PUT /onboarding/:id/task/:taskId - Update an onboarding task
 */
router.put('/:id/task/:taskId', verifyToken, async (req, res) => {
  try {
    const { id, taskId } = req.params;
    const { status, notes, assignedTo } = req.body;
    
    // Validate required fields
    if (!status) {
      return res.status(400).json({
        message: 'Task status is required'
      });
    }
    
    // Get the onboarding record
    const params = {
      TableName: ONBOARDING_TABLE,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: {
        ':pk': `ONBOARDING#${id}`
      }
    };
    
    const result = await dynamodb.query(params).promise();
    
    if (!result.Items || result.Items.length === 0) {
      return res.status(404).json({
        message: 'Onboarding record not found'
      });
    }
    
    const onboarding = result.Items[0];
    
    // Check if user has permission (task assignee, manager, HR, or admin)
    const taskIndex = onboarding.checklist.findIndex(task => task.id === taskId);
    
    if (taskIndex === -1) {
      return res.status(404).json({
        message: 'Task not found in onboarding checklist'
      });
    }
    
    const task = onboarding.checklist[taskIndex];
    
    // Check permission - task assignee, employee's manager, HR, or admin can update
    const isAssignee = task.assignedTo === req.user.id;
    const isManager = onboarding.manager === req.user.id;
    const isHrOrAdmin = req.user.accessLevel >= 4;
    
    if (!isAssignee && !isManager && !isHrOrAdmin) {
      return res.status(403).json({
        message: 'You are not authorized to update this task'
      });
    }
    
    // Update the task
    const updatedTask = {
      ...task,
      status,
      notes: notes || task.notes || '',
      updatedBy: req.user.id,
      updatedByName: req.user.name,
      updatedAt: new Date().toISOString()
    };
    
    if (assignedTo) {
      updatedTask.assignedTo = assignedTo;
    }
    
    if (status === 'completed' && !updatedTask.completedDate) {
      updatedTask.completedDate = new Date().toISOString();
    }
    
    // Update the checklist
    const updatedChecklist = [...onboarding.checklist];
    updatedChecklist[taskIndex] = updatedTask;
    
    // Calculate progress
    const completedTasks = updatedChecklist.filter(t => t.status === 'completed').length;
    const progress = Math.round((completedTasks / updatedChecklist.length) * 100);
    
    // Determine if all tasks are complete
    const allTasksCompleted = updatedChecklist.every(t => t.status === 'completed');
    const newStatus = allTasksCompleted ? 'completed' : 'in_progress';
    
    // Update the onboarding record
    const updateParams = {
      TableName: ONBOARDING_TABLE,
      Key: {
        PK: onboarding.PK,
        SK: onboarding.SK
      },
      UpdateExpression: 'SET checklist = :checklist, progress = :progress, updatedAt = :updatedAt, #status = :status, GSI2SK = :gsi2sk',
      ExpressionAttributeNames: {
        '#status': 'status'
      },
      ExpressionAttributeValues: {
        ':checklist': updatedChecklist,
        ':progress': progress,
        ':updatedAt': new Date().toISOString(),
        ':status': newStatus,
        ':gsi2sk': `${newStatus}#${onboarding.createdAt}`
      },
      ReturnValues: 'ALL_NEW'
    };
    
    const updateResult = await dynamodb.update(updateParams).promise();
    
    return res.status(200).json({
      message: 'Onboarding task updated successfully',
      onboarding: updateResult.Attributes
    });
  } catch (error) {
    console.error('Error updating onboarding task:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * POST /onboarding/offboarding/start - Initiate offboarding for an employee
 */
router.post('/offboarding/start', verifyToken, checkAccess(4), authorizeFeature('employee.offboarding'), async (req, res) => {
  try {
    const {
      employeeId,
      lastWorkingDate,
      reason,
      returnItems = [],
      checklist = [],
      notes
    } = req.body;
    
    // Validate required fields
    if (!employeeId || !lastWorkingDate || !reason) {
      return res.status(400).json({
        message: 'Employee ID, last working date, and reason are required'
      });
    }
    
    // Verify the employee exists
    const employeeParams = {
      TableName: EMPLOYEES_TABLE,
      Key: {
        PK: `EMPLOYEE#${employeeId}`,
        SK: 'PROFILE'
      }
    };
    
    const employeeResult = await dynamodb.get(employeeParams).promise();
    
    if (!employeeResult.Item) {
      return res.status(404).json({
        message: 'Employee not found'
      });
    }
    
    const offboardingId = uuidv4();
    const timestamp = new Date().toISOString();
    
    // Define default offboarding checklist if not provided
    let offboardingChecklist = checklist.length > 0 ? checklist : [
      {
        id: uuidv4(),
        title: 'Exit interview',
        category: 'HR',
        status: 'pending',
        assignedTo: req.user.id,
        dueDate: new Date(new Date(lastWorkingDate).getTime() - 86400000 * 3).toISOString(), // 3 days before last day
        completedDate: null
      },
      {
        id: uuidv4(),
        title: 'Return company assets',
        category: 'IT',
        status: 'pending',
        assignedTo: null, // To be assigned
        dueDate: new Date(lastWorkingDate).toISOString(),
        completedDate: null
      },
      {
        id: uuidv4(),
        title: 'Revoke system access',
        category: 'IT',
        status: 'pending',
        assignedTo: null, // To be assigned
        dueDate: new Date(lastWorkingDate).toISOString(),
        completedDate: null
      },
      {
        id: uuidv4(),
        title: 'Process final payroll',
        category: 'Finance',
        status: 'pending',
        assignedTo: null, // To be assigned
        dueDate: new Date(new Date(lastWorkingDate).getTime() + 86400000 * 7).toISOString(), // 7 days after last day
        completedDate: null
      },
      {
        id: uuidv4(),
        title: 'Update organization chart',
        category: 'HR',
        status: 'pending',
        assignedTo: req.user.id,
        dueDate: new Date(new Date(lastWorkingDate).getTime() + 86400000).toISOString(), // 1 day after last day
        completedDate: null
      }
    ];
    
    const newOffboarding = {
      PK: `OFFBOARDING#${offboardingId}`,
      SK: `EMPLOYEE#${employeeId}`,
      offboardingId,
      employeeId,
      employeeName: `${employeeResult.Item.firstName} ${employeeResult.Item.lastName}`,
      lastWorkingDate,
      reason,
      status: 'in_progress',
      progress: 0,
      checklist: offboardingChecklist,
      returnItems: returnItems || [],
      createdBy: req.user.id,
      createdByName: req.user.name,
      createdAt: timestamp,
      updatedAt: timestamp,
      notes: notes || '',
      type: 'offboarding',
      GSI1PK: `EMPLOYEE#${employeeId}`,
      GSI1SK: `OFFBOARDING#${timestamp}`,
      GSI2PK: 'OFFBOARDING#STATUS',
      GSI2SK: `in_progress#${timestamp}`
    };
    
    await dynamodb.put({
      TableName: ONBOARDING_TABLE, // Using same table for offboarding with different PK prefix
      Item: newOffboarding
    }).promise();
    
    // Get all assets assigned to employee
    const assetsParams = {
      TableName: ASSETS_TABLE,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :employeeId',
      ExpressionAttributeValues: {
        ':employeeId': `EMPLOYEE#${employeeId}`
      }
    };
    
    const assetsResult = await dynamodb.query(assetsParams).promise();
    const employeeAssets = assetsResult.Items || [];
    
    // If employee has assets, update their status to "pending return"
    for (const asset of employeeAssets) {
      const updateAssetParams = {
        TableName: ASSETS_TABLE,
        Key: {
          PK: asset.PK,
          SK: asset.SK
        },
        UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt, notes = list_append(if_not_exists(notes, :emptyList), :note)',
        ExpressionAttributeNames: {
          '#status': 'status'
        },
        ExpressionAttributeValues: {
          ':status': 'pending_return',
          ':updatedAt': timestamp,
          ':emptyList': [],
          ':note': [{
            text: `Asset marked for return due to employee offboarding, last working day: ${new Date(lastWorkingDate).toLocaleDateString()}`,
            timestamp,
            addedBy: req.user.id
          }]
        }
      };
      
      await dynamodb.update(updateAssetParams).promise();
    }
    
    // Update employee status in employee table
    const updateEmployeeParams = {
      TableName: EMPLOYEES_TABLE,
      Key: {
        PK: `EMPLOYEE#${employeeId}`,
        SK: 'PROFILE'
      },
      UpdateExpression: 'SET #status = :status, exitDate = :exitDate, exitReason = :exitReason, updatedAt = :updatedAt, updatedBy = :updatedBy',
      ExpressionAttributeNames: {
        '#status': 'status'
      },
      ExpressionAttributeValues: {
        ':status': 'exiting',
        ':exitDate': lastWorkingDate,
        ':exitReason': reason,
        ':updatedAt': timestamp,
        ':updatedBy': req.user.id
      }
    };
    
    await dynamodb.update(updateEmployeeParams).promise();
    
    return res.status(201).json({
      message: 'Offboarding process initiated successfully',
      offboarding: newOffboarding,
      assetsToReturn: employeeAssets.length
    });
  } catch (error) {
    console.error('Error initiating offboarding:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * GET /onboarding/employee/:employeeId - Get all onboarding/offboarding records for an employee
 */
router.get('/employee/:employeeId', verifyToken, checkAccess(3), async (req, res) => {
  try {
    const { employeeId } = req.params;
    
    // Query by GSI1 to get all onboarding/offboarding records for this employee
    const params = {
      TableName: ONBOARDING_TABLE,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :employeeId',
      ExpressionAttributeValues: {
        ':employeeId': `EMPLOYEE#${employeeId}`
      }
    };
    
    const result = await dynamodb.query(params).promise();
    
    return res.status(200).json({
      message: 'Records retrieved successfully',
      records: result.Items || []
    });
  } catch (error) {
    console.error('Error retrieving onboarding/offboarding records:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * GET /onboarding/status/:status - Get all onboarding/offboarding records with a specific status
 */
router.get('/status/:status', verifyToken, checkAccess(3), async (req, res) => {
  try {
    const { status } = req.params;
    const { type } = req.query; // 'onboarding' or 'offboarding'
    
    if (!['in_progress', 'completed', 'cancelled'].includes(status)) {
      return res.status(400).json({
        message: 'Invalid status. Must be in_progress, completed, or cancelled'
      });
    }
    
    // Query by GSI2 to get all records with this status
    let params = {
      TableName: ONBOARDING_TABLE,
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :processType AND begins_with(GSI2SK, :status)',
      ExpressionAttributeValues: {
        ':processType': type === 'offboarding' ? 'OFFBOARDING#STATUS' : 'ONBOARDING#STATUS',
        ':status': `${status}#`
      }
    };
    
    const result = await dynamodb.query(params).promise();
    
    return res.status(200).json({
      message: 'Records retrieved successfully',
      records: result.Items || []
    });
  } catch (error) {
    console.error('Error retrieving records by status:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

module.exports = router;

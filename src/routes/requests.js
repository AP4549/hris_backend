const express = require('express');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');
const checkAccess = require('../middleware/checkAccess');
const checkApprovalAuthority = require('../middleware/checkApprovalAuthority');
const AWS = require('aws-sdk');
const { v4: uuidv4 } = require('uuid');

const dynamodb = new AWS.DynamoDB.DocumentClient();
const REQUESTS_TABLE = process.env.REQUESTS_TABLE;

// POST /requests - Create a new request (leave, training, reimbursement, etc.)
router.post('/', verifyToken, async (req, res) => {
  try {
    const { type, startDate, endDate, reason, details } = req.body;
    const employeeId = req.user.id;
    const employeeName = req.user.name;
    const employeeDepartment = req.user.department;
    
    // Validate request type
    const validTypes = ['leave', 'training', 'reimbursement', 'equipment', 'document'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ message: 'Invalid request type' });
    }
    
    const requestId = uuidv4();
    const timestamp = new Date().toISOString();
    
    const newRequest = {
      PK: `REQUEST#${requestId}`,
      SK: `EMPLOYEE#${employeeId}`,
      requestId,
      employeeId,
      employeeName,
      employeeDepartment,
      type,
      startDate,
      endDate,
      reason,
      details,
      status: 'pending',
      createdAt: timestamp,
      updatedAt: timestamp,
      GSI1PK: `EMPLOYEE#${employeeId}`,
      GSI1SK: `REQUEST#${type}#${timestamp}`,
      GSI2PK: `REQUEST#${type}`,
      GSI2SK: `STATUS#pending#${timestamp}`
    };
    
    await dynamodb.put({
      TableName: REQUESTS_TABLE,
      Item: newRequest
    }).promise();
    
    return res.status(201).json({
      message: 'Request created successfully',
      request: newRequest
    });
  } catch (error) {
    console.error('Error creating request:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// GET /requests - Get all requests for current user
router.get('/', verifyToken, async (req, res) => {
  try {
    const employeeId = req.user.id;
    
    const params = {
      TableName: REQUESTS_TABLE,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: {
        ':pk': `EMPLOYEE#${employeeId}`
      }
    };
    
    const result = await dynamodb.query(params).promise();
    
    return res.status(200).json({
      message: 'Requests retrieved successfully',
      requests: result.Items
    });
  } catch (error) {
    console.error('Error retrieving requests:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// GET /requests/:id - Get specific request
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const requestId = req.params.id;
    const employeeId = req.user.id;
    
    // First check if user is the request owner
    let params = {
      TableName: REQUESTS_TABLE,
      Key: {
        PK: `REQUEST#${requestId}`,
        SK: `EMPLOYEE#${employeeId}`
      }
    };
    
    let result = await dynamodb.get(params).promise();
    
    // If not found and user is a manager, check if they can access it as an approver
    if (!result.Item && req.user.accessLevel >= 3) {
      params = {
        TableName: REQUESTS_TABLE,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: {
          ':pk': `REQUEST#${requestId}`
        }
      };
      
      result = await dynamodb.query(params).promise();
      
      // Check if the manager is authorized to view this request
      if (result.Items && result.Items.length > 0) {
        const request = result.Items[0];
        const canAccess = await checkApprovalAuthority(req.user, request.employeeDepartment);
        
        if (!canAccess) {
          return res.status(403).json({ message: 'Unauthorized to access this request' });
        }
      }
    }
    
    if (!result.Item && (!result.Items || result.Items.length === 0)) {
      return res.status(404).json({ message: 'Request not found' });
    }
    
    const request = result.Item || result.Items[0];
    
    return res.status(200).json({
      message: 'Request retrieved successfully',
      request
    });
  } catch (error) {
    console.error('Error retrieving request:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// PUT /requests/:id - Update request status (approve/reject)
router.put('/:id', verifyToken, checkAccess(3), async (req, res) => {
  try {
    const requestId = req.params.id;
    const { status, comments } = req.body;
    
    // Validate status
    const validStatuses = ['approved', 'rejected', 'pending'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }
    
    // Get the request first to check department and current status
    const getParams = {
      TableName: REQUESTS_TABLE,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: {
        ':pk': `REQUEST#${requestId}`
      }
    };
    
    const getResult = await dynamodb.query(getParams).promise();
    
    if (!getResult.Items || getResult.Items.length === 0) {
      return res.status(404).json({ message: 'Request not found' });
    }
    
    const request = getResult.Items[0];
    
    // Check if manager has authority to approve this request
    const canApprove = await checkApprovalAuthority(req.user, request.employeeDepartment);
    
    if (!canApprove) {
      return res.status(403).json({ message: 'Unauthorized to update this request' });
    }
    
    // Update the request
    const timestamp = new Date().toISOString();
    
    const updateParams = {
      TableName: REQUESTS_TABLE,
      Key: {
        PK: `REQUEST#${requestId}`,
        SK: request.SK
      },
      UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt, approverComments = :comments, approverId = :approverId, approverName = :approverName, GSI2SK = :gsi2sk',
      ExpressionAttributeNames: {
        '#status': 'status'
      },
      ExpressionAttributeValues: {
        ':status': status,
        ':updatedAt': timestamp,
        ':comments': comments || null,
        ':approverId': req.user.id,
        ':approverName': req.user.name,
        ':gsi2sk': `STATUS#${status}#${timestamp}`
      },
      ReturnValues: 'ALL_NEW'
    };
    
    const updateResult = await dynamodb.update(updateParams).promise();
    
    return res.status(200).json({
      message: 'Request updated successfully',
      request: updateResult.Attributes
    });
  } catch (error) {
    console.error('Error updating request:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// GET /requests/pending - Get all pending requests (for managers)
router.get('/pending/:type', verifyToken, checkAccess(3), async (req, res) => {
  try {
    const type = req.params.type;
    const validTypes = ['leave', 'training', 'reimbursement', 'equipment', 'document', 'all'];
    
    if (!validTypes.includes(type)) {
      return res.status(400).json({ message: 'Invalid request type' });
    }
    
    let params = {
      TableName: REQUESTS_TABLE,
      IndexName: 'GSI2',
      KeyConditionExpression: type === 'all' ? 
        'begins_with(GSI2SK, :statusPrefix)' :
        'GSI2PK = :type AND begins_with(GSI2SK, :statusPrefix)',
      ExpressionAttributeValues: {
        ':statusPrefix': 'STATUS#pending',
        ...(type !== 'all' && { ':type': `REQUEST#${type}` })
      }
    };
    
    const result = await dynamodb.query(params).promise();
    
    // Filter results based on department access
    const filteredRequests = [];
    for (const request of result.Items) {
      const canAccess = await checkApprovalAuthority(req.user, request.employeeDepartment);
      if (canAccess) {
        filteredRequests.push(request);
      }
    }
    
    return res.status(200).json({
      message: 'Pending requests retrieved successfully',
      requests: filteredRequests
    });
  } catch (error) {
    console.error('Error retrieving pending requests:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// DELETE /requests/:id - Cancel a request (only if pending and own request)
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    const requestId = req.params.id;
    const employeeId = req.user.id;
    
    // Get the request first
    const params = {
      TableName: REQUESTS_TABLE,
      Key: {
        PK: `REQUEST#${requestId}`,
        SK: `EMPLOYEE#${employeeId}`
      }
    };
    
    const result = await dynamodb.get(params).promise();
    
    if (!result.Item) {
      return res.status(404).json({ message: 'Request not found or unauthorized' });
    }
    
    // Check if request is pending
    if (result.Item.status !== 'pending') {
      return res.status(400).json({ message: 'Only pending requests can be cancelled' });
    }
    
    // Delete the request
    await dynamodb.delete(params).promise();
    
    return res.status(200).json({
      message: 'Request cancelled successfully'
    });
  } catch (error) {
    console.error('Error cancelling request:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

module.exports = router;

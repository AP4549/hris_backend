const express = require('express');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');
const checkAccess = require('../middleware/checkAccess');
const authorizeFeature = require('../middleware/authorizeFeature');
const AWS = require('aws-sdk');
const { v4: uuidv4 } = require('uuid');

const dynamodb = new AWS.DynamoDB.DocumentClient();
const ASSETS_TABLE = process.env.HRIS_ASSETS_TABLE || 'hris_assets';
const EMPLOYEES_TABLE = process.env.HRIS_EMPLOYEES_TABLE || 'hris_employees';

/**
 * POST /assets - Register a new asset
 */
router.post('/', verifyToken, checkAccess(3), authorizeFeature('assets.create'), async (req, res) => {
  try {
    const {
      assetType,
      model,
      manufacturer,
      serialNumber,
      purchaseDate,
      purchaseValue,
      warranty,
      status = 'available',
      notes,
      location,
      department
    } = req.body;
    
    // Validate required fields
    if (!assetType || !model || !serialNumber) {
      return res.status(400).json({
        message: 'Asset type, model, and serial number are required'
      });
    }
    
    // Check if asset with this serial number already exists
    const checkParams = {
      TableName: ASSETS_TABLE,
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :serialNumber',
      ExpressionAttributeValues: {
        ':serialNumber': `SERIAL#${serialNumber}`
      }
    };
    
    const checkResult = await dynamodb.query(checkParams).promise();
    
    if (checkResult.Items && checkResult.Items.length > 0) {
      return res.status(400).json({
        message: 'An asset with this serial number already exists'
      });
    }
    
    const assetId = uuidv4();
    const timestamp = new Date().toISOString();
    
    const newAsset = {
      PK: `ASSET#${assetId}`,
      SK: 'INFO',
      assetId,
      assetType,
      model,
      manufacturer,
      serialNumber,
      purchaseDate: purchaseDate || null,
      purchaseValue: purchaseValue || null,
      warranty: warranty || null,
      status,
      location: location || null,
      department: department || null,
      assignedTo: null,
      assignedToName: null,
      assignedDate: null,
      createdBy: req.user.id,
      createdByName: req.user.name,
      createdAt: timestamp,
      updatedAt: timestamp,
      notes: notes ? [{ text: notes, timestamp, addedBy: req.user.id }] : [],
      GSI1PK: department ? `DEPARTMENT#${department}` : 'DEPARTMENT#unassigned',
      GSI1SK: `ASSET#${assetType}#${timestamp}`,
      GSI2PK: `SERIAL#${serialNumber}`,
      GSI2SK: `STATUS#${status}`
    };
    
    await dynamodb.put({
      TableName: ASSETS_TABLE,
      Item: newAsset
    }).promise();
    
    return res.status(201).json({
      message: 'Asset registered successfully',
      asset: newAsset
    });
  } catch (error) {
    console.error('Error registering asset:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * POST /assets/assign - Assign asset to an employee
 */
router.post('/assign', verifyToken, checkAccess(3), authorizeFeature('assets.assign'), async (req, res) => {
  try {
    const {
      assetId,
      employeeId,
      notes,
      condition
    } = req.body;
    
    // Validate required fields
    if (!assetId || !employeeId) {
      return res.status(400).json({
        message: 'Asset ID and Employee ID are required'
      });
    }
    
    // Check if asset exists and is available
    const assetParams = {
      TableName: ASSETS_TABLE,
      Key: {
        PK: `ASSET#${assetId}`,
        SK: 'INFO'
      }
    };
    
    const assetResult = await dynamodb.get(assetParams).promise();
    
    if (!assetResult.Item) {
      return res.status(404).json({
        message: 'Asset not found'
      });
    }
    
    const asset = assetResult.Item;
    
    if (asset.status !== 'available' && asset.status !== 'maintenance_complete') {
      return res.status(400).json({
        message: `Asset is not available for assignment. Current status: ${asset.status}`
      });
    }
    
    // Check if employee exists
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
    
    const employee = employeeResult.Item;
    const timestamp = new Date().toISOString();
    
    // Update asset record
    const updateParams = {
      TableName: ASSETS_TABLE,
      Key: {
        PK: `ASSET#${assetId}`,
        SK: 'INFO'
      },
      UpdateExpression: 'SET #status = :status, assignedTo = :employeeId, assignedToName = :employeeName, ' +
                       'assignedDate = :timestamp, updatedAt = :timestamp, department = :department, ' +
                       'notes = list_append(if_not_exists(notes, :emptyList), :note), ' +
                       'GSI1PK = :gsi1pk, GSI1SK = :gsi1sk, GSI2SK = :gsi2sk',
      ExpressionAttributeNames: {
        '#status': 'status'
      },
      ExpressionAttributeValues: {
        ':status': 'assigned',
        ':employeeId': employeeId,
        ':employeeName': `${employee.firstName} ${employee.lastName}`,
        ':timestamp': timestamp,
        ':department': employee.department,
        ':emptyList': [],
        ':note': [{
          text: notes || `Asset assigned to ${employee.firstName} ${employee.lastName}`,
          condition: condition || 'Good',
          timestamp,
          addedBy: req.user.id,
          addedByName: req.user.name
        }],
        ':gsi1pk': `DEPARTMENT#${employee.department}`,
        ':gsi1sk': `ASSET#${asset.assetType}#${asset.createdAt}`,
        ':gsi2sk': 'STATUS#assigned'
      },
      ReturnValues: 'ALL_NEW'
    };
    
    const updateResult = await dynamodb.update(updateParams).promise();
    
    // Create assignment history record
    const historyParams = {
      TableName: ASSETS_TABLE,
      Item: {
        PK: `ASSET#${assetId}`,
        SK: `HISTORY#${timestamp}`,
        assetId,
        employeeId,
        employeeName: `${employee.firstName} ${employee.lastName}`,
        action: 'assigned',
        actionBy: req.user.id,
        actionByName: req.user.name,
        timestamp,
        notes: notes || null,
        condition: condition || 'Good',
        GSI1PK: `EMPLOYEE#${employeeId}`,
        GSI1SK: `ASSET#${assetId}`
      }
    };
    
    await dynamodb.put(historyParams).promise();
    
    return res.status(200).json({
      message: 'Asset assigned successfully',
      asset: updateResult.Attributes
    });
  } catch (error) {
    console.error('Error assigning asset:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * PUT /assets/return/:assetId - Mark an asset as returned
 */
router.put('/return/:assetId', verifyToken, checkAccess(3), authorizeFeature('assets.manage'), async (req, res) => {
  try {
    const { assetId } = req.params;
    const { notes, condition, maintenanceRequired } = req.body;
    
    // Check if asset exists and is assigned
    const assetParams = {
      TableName: ASSETS_TABLE,
      Key: {
        PK: `ASSET#${assetId}`,
        SK: 'INFO'
      }
    };
    
    const assetResult = await dynamodb.get(assetParams).promise();
    
    if (!assetResult.Item) {
      return res.status(404).json({
        message: 'Asset not found'
      });
    }
    
    const asset = assetResult.Item;
    
    if (asset.status !== 'assigned' && asset.status !== 'pending_return') {
      return res.status(400).json({
        message: `Asset is not currently assigned. Current status: ${asset.status}`
      });
    }
    
    // Capture the employee details before updating
    const previousEmployeeId = asset.assignedTo;
    const previousEmployeeName = asset.assignedToName;
    const timestamp = new Date().toISOString();
    
    // Determine new status based on maintenance required
    const newStatus = maintenanceRequired ? 'maintenance_required' : 'available';
    
    // Update asset record
    const updateParams = {
      TableName: ASSETS_TABLE,
      Key: {
        PK: `ASSET#${assetId}`,
        SK: 'INFO'
      },
      UpdateExpression: 'SET #status = :status, assignedTo = :null, assignedToName = :null, ' +
                       'updatedAt = :timestamp, ' +
                       'notes = list_append(if_not_exists(notes, :emptyList), :note), ' +
                       'GSI2SK = :gsi2sk',
      ExpressionAttributeNames: {
        '#status': 'status'
      },
      ExpressionAttributeValues: {
        ':status': newStatus,
        ':null': null,
        ':timestamp': timestamp,
        ':emptyList': [],
        ':note': [{
          text: notes || `Asset returned${maintenanceRequired ? ' - maintenance required' : ''}`,
          condition: condition || 'Unknown',
          timestamp,
          addedBy: req.user.id,
          addedByName: req.user.name
        }],
        ':gsi2sk': `STATUS#${newStatus}`
      },
      ReturnValues: 'ALL_NEW'
    };
    
    const updateResult = await dynamodb.update(updateParams).promise();
    
    // Create return history record
    const historyParams = {
      TableName: ASSETS_TABLE,
      Item: {
        PK: `ASSET#${assetId}`,
        SK: `HISTORY#${timestamp}`,
        assetId,
        employeeId: previousEmployeeId,
        employeeName: previousEmployeeName,
        action: 'returned',
        actionBy: req.user.id,
        actionByName: req.user.name,
        timestamp,
        notes: notes || null,
        condition: condition || 'Unknown',
        maintenanceRequired: maintenanceRequired || false,
        GSI1PK: `EMPLOYEE#${previousEmployeeId}`,
        GSI1SK: `ASSET#${assetId}`
      }
    };
    
    await dynamodb.put(historyParams).promise();
    
    return res.status(200).json({
      message: `Asset returned successfully${maintenanceRequired ? ' and marked for maintenance' : ''}`,
      asset: updateResult.Attributes
    });
  } catch (error) {
    console.error('Error processing asset return:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * GET /assets - Get all assets with filtering options
 */
router.get('/', verifyToken, checkAccess(3), async (req, res) => {
  try {
    const { status, type, department } = req.query;
    
    // Build query parameters based on filters
    let params = {};
    
    if (department) {
      params = {
        TableName: ASSETS_TABLE,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :department',
        ExpressionAttributeValues: {
          ':department': `DEPARTMENT#${department}`
        }
      };
      
      if (type) {
        params.KeyConditionExpression += ' AND begins_with(GSI1SK, :type)';
        params.ExpressionAttributeValues[':type'] = `ASSET#${type}`;
      }
    } else {
      // If no specific filters, get all assets with SK = INFO
      params = {
        TableName: ASSETS_TABLE,
        FilterExpression: 'SK = :info',
        ExpressionAttributeValues: {
          ':info': 'INFO'
        }
      };
      
      // Add additional filters if provided
      if (status) {
        params.FilterExpression += ' AND #status = :status';
        params.ExpressionAttributeValues[':status'] = status;
        
        if (!params.ExpressionAttributeNames) {
          params.ExpressionAttributeNames = {};
        }
        params.ExpressionAttributeNames['#status'] = 'status';
      }
      
      if (type) {
        params.FilterExpression += ' AND assetType = :type';
        params.ExpressionAttributeValues[':type'] = type;
      }
    }
    
    const result = await dynamodb.scan(params).promise();
    
    return res.status(200).json({
      message: 'Assets retrieved successfully',
      assets: result.Items || [],
      count: result.Count || 0
    });
  } catch (error) {
    console.error('Error retrieving assets:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * GET /assets/employee/:empId - Get all assets assigned to an employee
 */
router.get('/employee/:empId', verifyToken, async (req, res) => {
  try {
    const { empId } = req.params;
    
    // Verify employee exists
    const employeeParams = {
      TableName: EMPLOYEES_TABLE,
      Key: {
        PK: `EMPLOYEE#${empId}`,
        SK: 'PROFILE'
      }
    };
    
    const employeeResult = await dynamodb.get(employeeParams).promise();
    
    if (!employeeResult.Item && req.user.id !== empId) {
      return res.status(404).json({
        message: 'Employee not found'
      });
    }
    
    // Check if user is authorized to view this employee's assets
    if (req.user.id !== empId && req.user.accessLevel < 3) {
      return res.status(403).json({
        message: 'Unauthorized to view these assets'
      });
    }
    
    // Get assets currently assigned to this employee
    const currentAssetsParams = {
      TableName: ASSETS_TABLE,
      FilterExpression: 'assignedTo = :employeeId AND SK = :info',
      ExpressionAttributeValues: {
        ':employeeId': empId,
        ':info': 'INFO'
      }
    };
    
    const currentAssetsResult = await dynamodb.scan(currentAssetsParams).promise();
    
    // Get historical asset assignments for this employee
    const historyParams = {
      TableName: ASSETS_TABLE,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :employeeId AND begins_with(GSI1SK, :prefix)',
      ExpressionAttributeValues: {
        ':employeeId': `EMPLOYEE#${empId}`,
        ':prefix': 'ASSET#'
      }
    };
    
    const historyResult = await dynamodb.query(historyParams).promise();
    
    return res.status(200).json({
      message: 'Assets retrieved successfully',
      currentAssets: currentAssetsResult.Items || [],
      assetHistory: historyResult.Items || []
    });
  } catch (error) {
    console.error('Error retrieving employee assets:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * GET /assets/:assetId - Get details of a specific asset
 */
router.get('/:assetId', verifyToken, async (req, res) => {
  try {
    const { assetId } = req.params;
    
    // Get the asset details
    const assetParams = {
      TableName: ASSETS_TABLE,
      Key: {
        PK: `ASSET#${assetId}`,
        SK: 'INFO'
      }
    };
    
    const assetResult = await dynamodb.get(assetParams).promise();
    
    if (!assetResult.Item) {
      return res.status(404).json({
        message: 'Asset not found'
      });
    }
    
    // Get asset history
    const historyParams = {
      TableName: ASSETS_TABLE,
      KeyConditionExpression: 'PK = :assetId AND begins_with(SK, :history)',
      ExpressionAttributeValues: {
        ':assetId': `ASSET#${assetId}`,
        ':history': 'HISTORY#'
      }
    };
    
    const historyResult = await dynamodb.query(historyParams).promise();
    
    return res.status(200).json({
      message: 'Asset details retrieved successfully',
      asset: assetResult.Item,
      history: historyResult.Items || []
    });
  } catch (error) {
    console.error('Error retrieving asset details:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * PUT /assets/:assetId - Update asset details
 */
router.put('/:assetId', verifyToken, checkAccess(3), authorizeFeature('assets.manage'), async (req, res) => {
  try {
    const { assetId } = req.params;
    const {
      model,
      manufacturer,
      location,
      status,
      notes,
      warranty,
      purchaseValue,
      department
    } = req.body;
    
    // Check if asset exists
    const assetParams = {
      TableName: ASSETS_TABLE,
      Key: {
        PK: `ASSET#${assetId}`,
        SK: 'INFO'
      }
    };
    
    const assetResult = await dynamodb.get(assetParams).promise();
    
    if (!assetResult.Item) {
      return res.status(404).json({
        message: 'Asset not found'
      });
    }
    
    const asset = assetResult.Item;
    const timestamp = new Date().toISOString();
    
    // Build update expression
    const updateExpressions = [];
    const expressionAttributeValues = {
      ':timestamp': timestamp
    };
    const expressionAttributeNames = {};
    
    if (model) {
      updateExpressions.push('model = :model');
      expressionAttributeValues[':model'] = model;
    }
    
    if (manufacturer) {
      updateExpressions.push('manufacturer = :manufacturer');
      expressionAttributeValues[':manufacturer'] = manufacturer;
    }
    
    if (location) {
      updateExpressions.push('location = :location');
      expressionAttributeValues[':location'] = location;
    }
    
    if (warranty) {
      updateExpressions.push('warranty = :warranty');
      expressionAttributeValues[':warranty'] = warranty;
    }
    
    if (purchaseValue) {
      updateExpressions.push('purchaseValue = :purchaseValue');
      expressionAttributeValues[':purchaseValue'] = purchaseValue;
    }
    
    if (status) {
      updateExpressions.push('#status = :status');
      expressionAttributeValues[':status'] = status;
      expressionAttributeNames['#status'] = 'status';
      
      // Update GSI2SK for status change
      updateExpressions.push('GSI2SK = :gsi2sk');
      expressionAttributeValues[':gsi2sk'] = `STATUS#${status}`;
    }
    
    if (department) {
      updateExpressions.push('department = :department');
      expressionAttributeValues[':department'] = department;
      
      // Update GSI1PK for department change
      updateExpressions.push('GSI1PK = :gsi1pk');
      expressionAttributeValues[':gsi1pk'] = `DEPARTMENT#${department}`;
    }
    
    // Always update the timestamp
    updateExpressions.push('updatedAt = :timestamp');
    
    // Add note if provided
    if (notes) {
      updateExpressions.push('notes = list_append(if_not_exists(notes, :emptyList), :note)');
      expressionAttributeValues[':emptyList'] = [];
      expressionAttributeValues[':note'] = [{
        text: notes,
        timestamp,
        addedBy: req.user.id,
        addedByName: req.user.name
      }];
    }
    
    if (updateExpressions.length === 0) {
      return res.status(400).json({
        message: 'No fields to update'
      });
    }
    
    const updateParams = {
      TableName: ASSETS_TABLE,
      Key: {
        PK: `ASSET#${assetId}`,
        SK: 'INFO'
      },
      UpdateExpression: `SET ${updateExpressions.join(', ')}`,
      ExpressionAttributeValues: expressionAttributeValues,
      ExpressionAttributeNames: Object.keys(expressionAttributeNames).length > 0 ? expressionAttributeNames : undefined,
      ReturnValues: 'ALL_NEW'
    };
    
    const updateResult = await dynamodb.update(updateParams).promise();
    
    return res.status(200).json({
      message: 'Asset updated successfully',
      asset: updateResult.Attributes
    });
  } catch (error) {
    console.error('Error updating asset:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

module.exports = router;

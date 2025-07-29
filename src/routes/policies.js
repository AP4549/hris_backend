const express = require('express');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');
const checkAccess = require('../middleware/checkAccess');
const AWS = require('aws-sdk');
const { v4: uuidv4 } = require('uuid');

const dynamodb = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();
const POLICIES_TABLE = process.env.POLICIES_TABLE;
const BUCKET_NAME = process.env.DOCUMENT_BUCKET;

// POST /policies - Create a new policy (Admin only)
router.post('/', verifyToken, checkAccess(5), async (req, res) => {
  try {
    const {
      title,
      description,
      category,
      content,
      effectiveDate,
      version,
      documentUrl
    } = req.body;
    
    const policyId = uuidv4();
    const timestamp = new Date().toISOString();
    
    const newPolicy = {
      PK: `POLICY#${policyId}`,
      SK: `v${version || '1.0'}`,
      policyId,
      title,
      description,
      category,
      content,
      effectiveDate: effectiveDate || timestamp,
      version: version || '1.0',
      status: 'active',
      documentUrl,
      createdAt: timestamp,
      updatedAt: timestamp,
      createdBy: req.user.id,
      createdByName: req.user.name,
      GSI1PK: `POLICY`,
      GSI1SK: `CATEGORY#${category}#${timestamp}`,
      GSI2PK: `POLICY#STATUS`,
      GSI2SK: `active#${timestamp}`
    };
    
    await dynamodb.put({
      TableName: POLICIES_TABLE,
      Item: newPolicy
    }).promise();
    
    return res.status(201).json({
      message: 'Policy created successfully',
      policy: newPolicy
    });
  } catch (error) {
    console.error('Error creating policy:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// GET /policies - Get all policies
router.get('/', verifyToken, async (req, res) => {
  try {
    const { category, status } = req.query;
    
    let params;
    
    if (category) {
      // Query by category using GSI1
      params = {
        TableName: POLICIES_TABLE,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :policy AND begins_with(GSI1SK, :category)',
        ExpressionAttributeValues: {
          ':policy': 'POLICY',
          ':category': `CATEGORY#${category}`
        }
      };
    } else if (status) {
      // Query by status using GSI2
      params = {
        TableName: POLICIES_TABLE,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :policyStatus AND begins_with(GSI2SK, :status)',
        ExpressionAttributeValues: {
          ':policyStatus': 'POLICY#STATUS',
          ':status': `${status}`
        }
      };
    } else {
      // Get all active policies if no filters
      params = {
        TableName: POLICIES_TABLE,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :policyStatus AND begins_with(GSI2SK, :status)',
        ExpressionAttributeValues: {
          ':policyStatus': 'POLICY#STATUS',
          ':status': 'active'
        }
      };
    }
    
    const result = await dynamodb.query(params).promise();
    
    return res.status(200).json({
      message: 'Policies retrieved successfully',
      policies: result.Items
    });
  } catch (error) {
    console.error('Error retrieving policies:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// GET /policies/:id - Get a specific policy
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const policyId = req.params.id;
    const { version } = req.query;
    
    const params = {
      TableName: POLICIES_TABLE,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: {
        ':pk': `POLICY#${policyId}`
      }
    };
    
    if (version) {
      params.KeyConditionExpression += ' AND SK = :sk';
      params.ExpressionAttributeValues[':sk'] = `v${version}`;
    }
    
    const result = await dynamodb.query(params).promise();
    
    if (!result.Items || result.Items.length === 0) {
      return res.status(404).json({ message: 'Policy not found' });
    }
    
    // If version not specified, return the latest version
    let policy;
    if (!version) {
      policy = result.Items.reduce((latest, current) => {
        if (!latest || current.SK > latest.SK) {
          return current;
        }
        return latest;
      }, null);
    } else {
      policy = result.Items[0];
    }
    
    return res.status(200).json({
      message: 'Policy retrieved successfully',
      policy
    });
  } catch (error) {
    console.error('Error retrieving policy:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// PUT /policies/:id - Update a policy (Admin only)
router.put('/:id', verifyToken, checkAccess(5), async (req, res) => {
  try {
    const policyId = req.params.id;
    const {
      title,
      description,
      category,
      content,
      effectiveDate,
      version,
      documentUrl,
      status
    } = req.body;
    
    // Get current policy to check if it exists
    const getParams = {
      TableName: POLICIES_TABLE,
      Key: {
        PK: `POLICY#${policyId}`,
        SK: `v${version || '1.0'}`
      }
    };
    
    const currentPolicy = await dynamodb.get(getParams).promise();
    
    if (!currentPolicy.Item) {
      return res.status(404).json({ message: 'Policy not found' });
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
    
    if (category && category !== currentPolicy.Item.category) {
      updateExpressions.push('#category = :category');
      expressionAttributeNames['#category'] = 'category';
      expressionAttributeValues[':category'] = category;
      
      // Update GSI1SK if category changes
      updateExpressions.push('GSI1SK = :gsi1sk');
      expressionAttributeValues[':gsi1sk'] = `CATEGORY#${category}#${currentPolicy.Item.createdAt}`;
    }
    
    if (content) {
      updateExpressions.push('#content = :content');
      expressionAttributeNames['#content'] = 'content';
      expressionAttributeValues[':content'] = content;
    }
    
    if (effectiveDate) {
      updateExpressions.push('#effectiveDate = :effectiveDate');
      expressionAttributeNames['#effectiveDate'] = 'effectiveDate';
      expressionAttributeValues[':effectiveDate'] = effectiveDate;
    }
    
    if (documentUrl) {
      updateExpressions.push('#documentUrl = :documentUrl');
      expressionAttributeNames['#documentUrl'] = 'documentUrl';
      expressionAttributeValues[':documentUrl'] = documentUrl;
    }
    
    if (status && status !== currentPolicy.Item.status) {
      updateExpressions.push('#status = :status');
      expressionAttributeNames['#status'] = 'status';
      expressionAttributeValues[':status'] = status;
      
      // Update GSI2SK if status changes
      updateExpressions.push('GSI2SK = :gsi2sk');
      expressionAttributeValues[':gsi2sk'] = `${status}#${currentPolicy.Item.createdAt}`;
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
      TableName: POLICIES_TABLE,
      Key: {
        PK: `POLICY#${policyId}`,
        SK: `v${version || '1.0'}`
      },
      UpdateExpression: `SET ${updateExpressions.join(', ')}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW'
    };
    
    const updateResult = await dynamodb.update(updateParams).promise();
    
    return res.status(200).json({
      message: 'Policy updated successfully',
      policy: updateResult.Attributes
    });
  } catch (error) {
    console.error('Error updating policy:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// POST /policies/:id/version - Create a new version of a policy (Admin only)
router.post('/:id/version', verifyToken, checkAccess(5), async (req, res) => {
  try {
    const policyId = req.params.id;
    const {
      title,
      description,
      category,
      content,
      effectiveDate,
      version,
      documentUrl
    } = req.body;
    
    if (!version) {
      return res.status(400).json({ message: 'New version number is required' });
    }
    
    // Check if policy exists
    const getParams = {
      TableName: POLICIES_TABLE,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: {
        ':pk': `POLICY#${policyId}`
      }
    };
    
    const existingPolicy = await dynamodb.query(getParams).promise();
    
    if (!existingPolicy.Items || existingPolicy.Items.length === 0) {
      return res.status(404).json({ message: 'Policy not found' });
    }
    
    // Check if version already exists
    const versionCheckParams = {
      TableName: POLICIES_TABLE,
      Key: {
        PK: `POLICY#${policyId}`,
        SK: `v${version}`
      }
    };
    
    const versionCheck = await dynamodb.get(versionCheckParams).promise();
    
    if (versionCheck.Item) {
      return res.status(400).json({ message: 'Version already exists' });
    }
    
    // Get the latest version of the policy to use as a base
    const latestVersion = existingPolicy.Items.reduce((latest, current) => {
      if (!latest || current.SK > latest.SK) {
        return current;
      }
      return latest;
    }, null);
    
    const timestamp = new Date().toISOString();
    
    const newVersionPolicy = {
      PK: `POLICY#${policyId}`,
      SK: `v${version}`,
      policyId,
      title: title || latestVersion.title,
      description: description || latestVersion.description,
      category: category || latestVersion.category,
      content: content || latestVersion.content,
      effectiveDate: effectiveDate || timestamp,
      version,
      status: 'active',
      documentUrl: documentUrl || latestVersion.documentUrl,
      createdAt: timestamp,
      updatedAt: timestamp,
      createdBy: req.user.id,
      createdByName: req.user.name,
      GSI1PK: 'POLICY',
      GSI1SK: `CATEGORY#${category || latestVersion.category}#${timestamp}`,
      GSI2PK: 'POLICY#STATUS',
      GSI2SK: `active#${timestamp}`
    };
    
    await dynamodb.put({
      TableName: POLICIES_TABLE,
      Item: newVersionPolicy
    }).promise();
    
    return res.status(201).json({
      message: 'New policy version created successfully',
      policy: newVersionPolicy
    });
  } catch (error) {
    console.error('Error creating policy version:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// POST /policies/:id/upload - Upload a policy document to S3
router.post('/:id/upload', verifyToken, checkAccess(5), async (req, res) => {
  try {
    const policyId = req.params.id;
    const { fileContent, fileName, contentType, version } = req.body;
    
    if (!fileContent || !fileName || !contentType) {
      return res.status(400).json({ message: 'File content, name, and content type are required' });
    }
    
    // Check if policy exists
    const getParams = {
      TableName: POLICIES_TABLE,
      Key: {
        PK: `POLICY#${policyId}`,
        SK: `v${version || '1.0'}`
      }
    };
    
    const existingPolicy = await dynamodb.get(getParams).promise();
    
    if (!existingPolicy.Item) {
      return res.status(404).json({ message: 'Policy not found' });
    }
    
    // Convert base64 to buffer for S3 upload
    const fileBuffer = Buffer.from(fileContent, 'base64');
    
    // Upload to S3
    const s3Key = `policies/${policyId}/${version || '1.0'}/${fileName}`;
    const s3Params = {
      Bucket: BUCKET_NAME,
      Key: s3Key,
      Body: fileBuffer,
      ContentType: contentType,
      ACL: 'private'
    };
    
    const s3Result = await s3.upload(s3Params).promise();
    
    // Update policy with document URL
    const updateParams = {
      TableName: POLICIES_TABLE,
      Key: {
        PK: `POLICY#${policyId}`,
        SK: `v${version || '1.0'}`
      },
      UpdateExpression: 'SET documentUrl = :documentUrl, updatedAt = :updatedAt, updatedBy = :updatedBy, updatedByName = :updatedByName',
      ExpressionAttributeValues: {
        ':documentUrl': s3Result.Location,
        ':updatedAt': new Date().toISOString(),
        ':updatedBy': req.user.id,
        ':updatedByName': req.user.name
      },
      ReturnValues: 'ALL_NEW'
    };
    
    const updateResult = await dynamodb.update(updateParams).promise();
    
    return res.status(200).json({
      message: 'Policy document uploaded successfully',
      policy: updateResult.Attributes,
      documentUrl: s3Result.Location
    });
  } catch (error) {
    console.error('Error uploading policy document:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// DELETE /policies/:id - Set a policy to inactive (Admin only)
router.delete('/:id', verifyToken, checkAccess(5), async (req, res) => {
  try {
    const policyId = req.params.id;
    const { version } = req.query;
    
    if (!version) {
      return res.status(400).json({ message: 'Version is required' });
    }
    
    // Check if policy exists
    const getParams = {
      TableName: POLICIES_TABLE,
      Key: {
        PK: `POLICY#${policyId}`,
        SK: `v${version}`
      }
    };
    
    const existingPolicy = await dynamodb.get(getParams).promise();
    
    if (!existingPolicy.Item) {
      return res.status(404).json({ message: 'Policy not found' });
    }
    
    // Update policy to inactive instead of deleting
    const timestamp = new Date().toISOString();
    const updateParams = {
      TableName: POLICIES_TABLE,
      Key: {
        PK: `POLICY#${policyId}`,
        SK: `v${version}`
      },
      UpdateExpression: 'SET #status = :status, GSI2SK = :gsi2sk, updatedAt = :updatedAt, updatedBy = :updatedBy, updatedByName = :updatedByName',
      ExpressionAttributeNames: {
        '#status': 'status'
      },
      ExpressionAttributeValues: {
        ':status': 'inactive',
        ':gsi2sk': `inactive#${existingPolicy.Item.createdAt}`,
        ':updatedAt': timestamp,
        ':updatedBy': req.user.id,
        ':updatedByName': req.user.name
      }
    };
    
    await dynamodb.update(updateParams).promise();
    
    return res.status(200).json({
      message: 'Policy set to inactive successfully'
    });
  } catch (error) {
    console.error('Error setting policy to inactive:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

module.exports = router;

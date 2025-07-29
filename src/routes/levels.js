const express = require('express');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');
const checkAccess = require('../middleware/checkAccess');
const AWS = require('aws-sdk');

const dynamodb = new AWS.DynamoDB.DocumentClient();
const LEVELS_TABLE = process.env.HRIS_LEVELS_TABLE || 'hris_levels';

/**
 * GET /levels - Get all access levels
 */
router.get('/', verifyToken, checkAccess(5), async (req, res) => {
  try {
    const params = {
      TableName: LEVELS_TABLE
    };

    const result = await dynamodb.scan(params).promise();

    return res.status(200).json({
      message: 'Access levels retrieved successfully',
      levels: result.Items || []
    });
  } catch (error) {
    console.error('Error retrieving access levels:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * POST /levels - Add or update an access level
 */
router.post('/', verifyToken, checkAccess(5), async (req, res) => {
  try {
    const { levelId, name, description } = req.body;

    if (!levelId || !name || !description) {
      return res.status(400).json({
        message: 'Level ID, Name, and Description are required'
      });
    }

    const params = {
      TableName: LEVELS_TABLE,
      Item: {
        PK: `LEVEL#${levelId}`,
        SK: 'INFO',
        name,
        description,
        updatedAt: new Date().toISOString()
      }
    };

    await dynamodb.put(params).promise();

    return res.status(200).json({
      message: 'Access level added/updated successfully'
    });
  } catch (error) {
    console.error('Error adding/updating access level:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

module.exports = router;

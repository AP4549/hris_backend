const express = require('express');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');
const checkAccess = require('../middleware/checkAccess');
const AWS = require('aws-sdk');

const dynamodb = new AWS.DynamoDB.DocumentClient();
const ORG_CHART_TABLE = process.env.HRIS_ORG_CHART_TABLE || 'hris_org_chart';

/**
 * GET /org-chart - Get the organization chart
 */
router.get('/', verifyToken, checkAccess(3), async (req, res) => {
  try {
    const params = {
      TableName: ORG_CHART_TABLE
    };

    const result = await dynamodb.scan(params).promise();

    return res.status(200).json({
      message: 'Organization chart retrieved successfully',
      orgChart: result.Items || []
    });
  } catch (error) {
    console.error('Error retrieving organization chart:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * POST /org-chart - Add or update an entry in the organization chart
 */
router.post('/', verifyToken, checkAccess(5), async (req, res) => {
  try {
    const { employeeId, managerId, department, position } = req.body;

    if (!employeeId || !managerId || !department || !position) {
      return res.status(400).json({
        message: 'Employee ID, Manager ID, Department, and Position are required'
      });
    }

    const params = {
      TableName: ORG_CHART_TABLE,
      Item: {
        PK: `EMPLOYEE#${employeeId}`,
        SK: 'ORG_CHART',
        managerId,
        department,
        position,
        updatedAt: new Date().toISOString()
      }
    };

    await dynamodb.put(params).promise();

    return res.status(200).json({
      message: 'Organization chart entry added/updated successfully'
    });
  } catch (error) {
    console.error('Error adding/updating organization chart entry:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

module.exports = router;

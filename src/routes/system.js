const express = require('express');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');
const checkAccess = require('../middleware/checkAccess');
const authorizeFeature = require('../middleware/authorizeFeature');
const AWS = require('aws-sdk');
const { v4: uuidv4 } = require('uuid');

const dynamodb = new AWS.DynamoDB.DocumentClient();
const PERMISSIONS_TABLE = process.env.HRIS_PERMISSIONS_TABLE || 'hris_permissions';
const ROLES_TABLE = process.env.HRIS_ROLES_TABLE || 'hris_roles';
const EMPLOYEES_TABLE = process.env.HRIS_EMPLOYEES_TABLE || 'hris_employees';

/**
 * GET /system/permissions - Get all permissions
 */
router.get('/permissions', verifyToken, authorizeFeature('system.permissions'), async (req, res) => {
  try {
    const permissions = await authorizeFeature.getAllPermissions();
    
    return res.status(200).json({
      message: 'Permissions retrieved successfully',
      permissions: Object.entries(permissions).map(([key, value]) => ({
        name: key,
        requiredLevel: value.defaultLevel,
        description: value.description,
        isCustom: value.isCustom || false
      }))
    });
  } catch (error) {
    console.error('Error retrieving permissions:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * POST /system/permissions - Create or update a permission
 */
router.post('/permissions', verifyToken, authorizeFeature('system.permissions'), async (req, res) => {
  try {
    const { permissionName, requiredLevel, description } = req.body;
    
    // Validate required fields
    if (!permissionName || !requiredLevel) {
      return res.status(400).json({
        message: 'Permission name and required level are required'
      });
    }
    
    // Ensure requiredLevel is a number between 1-5
    if (isNaN(requiredLevel) || requiredLevel < 1 || requiredLevel > 5) {
      return res.status(400).json({
        message: 'Required level must be a number between 1 and 5'
      });
    }
    
    const success = await authorizeFeature.setPermission(
      permissionName,
      Number(requiredLevel),
      description || `Permission for ${permissionName}`
    );
    
    if (success) {
      return res.status(200).json({
        message: 'Permission created/updated successfully',
        permission: {
          name: permissionName,
          requiredLevel: Number(requiredLevel),
          description: description || `Permission for ${permissionName}`
        }
      });
    } else {
      return res.status(500).json({
        message: 'Failed to create/update permission'
      });
    }
  } catch (error) {
    console.error('Error creating/updating permission:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * GET /system/roles - Get all roles
 */
router.get('/roles', verifyToken, authorizeFeature('system.permissions'), async (req, res) => {
  try {
    // Scan the roles table
    const rolesParams = {
      TableName: ROLES_TABLE
    };
    
    const rolesResult = await dynamodb.scan(rolesParams).promise();
    
    return res.status(200).json({
      message: 'Roles retrieved successfully',
      roles: rolesResult.Items || []
    });
  } catch (error) {
    console.error('Error retrieving roles:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * POST /system/roles - Create or update a role
 */
router.post('/roles', verifyToken, authorizeFeature('system.permissions'), async (req, res) => {
  try {
    const { roleId, roleName, permissions, description } = req.body;
    
    // Validate required fields
    if (!roleName || !permissions || !Array.isArray(permissions)) {
      return res.status(400).json({
        message: 'Role name and permissions array are required'
      });
    }
    
    // Generate a roleId if not provided
    const id = roleId || uuidv4();
    
    const success = await authorizeFeature.setRole(
      id,
      roleName,
      permissions,
      description || `Role: ${roleName}`
    );
    
    if (success) {
      return res.status(200).json({
        message: 'Role created/updated successfully',
        role: {
          roleId: id,
          roleName,
          permissions,
          description: description || `Role: ${roleName}`
        }
      });
    } else {
      return res.status(500).json({
        message: 'Failed to create/update role'
      });
    }
  } catch (error) {
    console.error('Error creating/updating role:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * POST /system/user/permissions - Assign specific permissions to a user
 */
router.post('/user/permissions', verifyToken, authorizeFeature('system.permissions'), async (req, res) => {
  try {
    const { employeeId, permissions } = req.body;
    
    // Validate required fields
    if (!employeeId || !permissions || typeof permissions !== 'object') {
      return res.status(400).json({
        message: 'Employee ID and permissions object are required'
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
    
    // Update employee with permissions
    const updateParams = {
      TableName: EMPLOYEES_TABLE,
      Key: {
        PK: `EMPLOYEE#${employeeId}`,
        SK: 'PROFILE'
      },
      UpdateExpression: 'SET permissions = :permissions',
      ExpressionAttributeValues: {
        ':permissions': permissions
      },
      ReturnValues: 'ALL_NEW'
    };
    
    const updateResult = await dynamodb.update(updateParams).promise();
    
    return res.status(200).json({
      message: 'User permissions updated successfully',
      employee: updateResult.Attributes
    });
  } catch (error) {
    console.error('Error updating user permissions:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * POST /system/user/roles - Assign roles to a user
 */
router.post('/user/roles', verifyToken, authorizeFeature('system.permissions'), async (req, res) => {
  try {
    const { employeeId, roles } = req.body;
    
    // Validate required fields
    if (!employeeId || !roles || !Array.isArray(roles)) {
      return res.status(400).json({
        message: 'Employee ID and roles array are required'
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
    
    // Update employee with roles
    const updateParams = {
      TableName: EMPLOYEES_TABLE,
      Key: {
        PK: `EMPLOYEE#${employeeId}`,
        SK: 'PROFILE'
      },
      UpdateExpression: 'SET roles = :roles',
      ExpressionAttributeValues: {
        ':roles': roles
      },
      ReturnValues: 'ALL_NEW'
    };
    
    const updateResult = await dynamodb.update(updateParams).promise();
    
    return res.status(200).json({
      message: 'User roles updated successfully',
      employee: updateResult.Attributes
    });
  } catch (error) {
    console.error('Error updating user roles:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * GET /system/access-levels - Get all defined access levels
 */
router.get('/access-levels', verifyToken, authorizeFeature('system.permissions'), async (req, res) => {
  try {
    // Retrieve access levels from the database
    // We'll store these in a settings table
    const accessLevelsParams = {
      TableName: process.env.HRIS_SETTINGS_TABLE || 'hris_settings',
      Key: {
        PK: 'SETTINGS',
        SK: 'ACCESS_LEVELS'
      }
    };
    
    const accessLevelsResult = await dynamodb.get(accessLevelsParams).promise();
    
    // Default access levels if not defined
    const defaultAccessLevels = {
      1: { name: 'Employee', description: 'Regular employee access' },
      2: { name: 'Team Lead', description: 'Team lead with limited management capabilities' },
      3: { name: 'Manager', description: 'Department manager with broader access' },
      4: { name: 'HR', description: 'Human Resources personnel' },
      5: { name: 'Admin', description: 'System administrator' }
    };
    
    const accessLevels = accessLevelsResult.Item ? 
      accessLevelsResult.Item.levels : 
      defaultAccessLevels;
    
    return res.status(200).json({
      message: 'Access levels retrieved successfully',
      accessLevels
    });
  } catch (error) {
    console.error('Error retrieving access levels:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * POST /system/access-levels - Update access level definitions
 */
router.post('/access-levels', verifyToken, authorizeFeature('system.permissions'), async (req, res) => {
  try {
    const { accessLevels } = req.body;
    
    // Validate the structure
    if (!accessLevels || typeof accessLevels !== 'object') {
      return res.status(400).json({
        message: 'Invalid access levels structure'
      });
    }
    
    // Ensure we have at least levels 1-5
    for (let i = 1; i <= 5; i++) {
      if (!accessLevels[i]) {
        return res.status(400).json({
          message: `Access level ${i} must be defined`
        });
      }
    }
    
    // Store access levels in the settings table
    const timestamp = new Date().toISOString();
    const updateParams = {
      TableName: process.env.HRIS_SETTINGS_TABLE || 'hris_settings',
      Item: {
        PK: 'SETTINGS',
        SK: 'ACCESS_LEVELS',
        levels: accessLevels,
        updatedAt: timestamp,
        updatedBy: req.user.id
      }
    };
    
    await dynamodb.put(updateParams).promise();
    
    return res.status(200).json({
      message: 'Access levels updated successfully',
      accessLevels
    });
  } catch (error) {
    console.error('Error updating access levels:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

module.exports = router;

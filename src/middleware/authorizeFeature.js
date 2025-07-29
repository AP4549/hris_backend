/**
 * Middleware to verify feature-specific access based on a feature name
 * Dynamic version that checks permissions from the database
 * 
 * @param {String} featureName - Name of the feature to authorize
 * @returns {Function} Express middleware
 */
const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient();
const PERMISSIONS_TABLE = process.env.HRIS_PERMISSIONS_TABLE || 'hris_permissions';
const ROLES_TABLE = process.env.HRIS_ROLES_TABLE || 'hris_roles';

// Cache for permissions to reduce database queries
const permissionsCache = {
  timestamp: null,
  permissions: {},
  roles: {},
  ttl: 5 * 60 * 1000 // 5 minutes cache TTL
};

async function refreshPermissionsCache() {
  try {
    // Get all permissions from the database
    const permissionsParams = {
      TableName: PERMISSIONS_TABLE
    };
    const permissionsResult = await dynamodb.scan(permissionsParams).promise();
    
    // Get all roles from the database
    const rolesParams = {
      TableName: ROLES_TABLE
    };
    const rolesResult = await dynamodb.scan(rolesParams).promise();
    
    // Update the cache
    permissionsCache.permissions = {};
    permissionsResult.Items.forEach(item => {
      permissionsCache.permissions[item.permissionName] = item;
    });
    
    permissionsCache.roles = {};
    rolesResult.Items.forEach(role => {
      permissionsCache.roles[role.roleId] = role;
    });
    
    permissionsCache.timestamp = Date.now();
    
    return true;
  } catch (error) {
    console.error('Error refreshing permissions cache:', error);
    return false;
  }
}

// Default feature permissions - used as fallback if database doesn't have entries
const defaultFeaturePermissions = {
  // Employee features
  'employee.view': { defaultLevel: 1, description: 'View own employee profile' },
  'employee.view.all': { defaultLevel: 3, description: 'View all employee profiles' },
  'employee.edit': { defaultLevel: 3, description: 'Edit own team employees' },
  'employee.edit.all': { defaultLevel: 4, description: 'Edit any employee profile' },
  'employee.create': { defaultLevel: 4, description: 'Create new employees' },
  'employee.delete': { defaultLevel: 5, description: 'Delete employee profiles' },
  
  // Request features
  'requests.create': { defaultLevel: 1, description: 'Create requests' },
  'requests.approve': { defaultLevel: 3, description: 'Approve team requests' },
  'requests.view.all': { defaultLevel: 3, description: 'View all requests' },
  'requests.manage': { defaultLevel: 4, description: 'Manage all requests' },
  
  // Document features
  'documents.upload': { defaultLevel: 1, description: 'Upload own documents' },
  'documents.view': { defaultLevel: 1, description: 'View own documents' },
  'documents.view.all': { defaultLevel: 4, description: 'View all documents' },
  'documents.manage': { defaultLevel: 4, description: 'Manage document system' },
  'documents.delete': { defaultLevel: 4, description: 'Delete documents' },
  
  // Policy features
  'policies.view': { defaultLevel: 1, description: 'View company policies' },
  'policies.create': { defaultLevel: 4, description: 'Create policies' },
  'policies.update': { defaultLevel: 4, description: 'Update policies' },
  'policies.delete': { defaultLevel: 5, description: 'Delete policies' },
  'policies.manage': { defaultLevel: 4, description: 'Manage policies' },
  
  // Training features
  'training.enroll': { defaultLevel: 1, description: 'Enroll in trainings' },
  'training.view': { defaultLevel: 1, description: 'View available trainings' },
  'training.create': { defaultLevel: 3, description: 'Create trainings' },
  'training.manage': { defaultLevel: 3, description: 'Manage trainings' },
  'training.delete': { defaultLevel: 4, description: 'Delete trainings' },
  'training.report': { defaultLevel: 4, description: 'Access training reports' },
  
  // Jobs/Recruitment features
  'jobs.view': { defaultLevel: 1, description: 'View job postings' },
  'jobs.apply': { defaultLevel: 1, description: 'Apply to job postings' },
  'jobs.post': { defaultLevel: 4, description: 'Post new job openings' },
  'jobs.manage': { defaultLevel: 4, description: 'Manage recruitment' },
  
  // Assets features
  'assets.assign': { defaultLevel: 3, description: 'Assign assets to employees' },
  'assets.create': { defaultLevel: 3, description: 'Create new assets' },
  'assets.manage': { defaultLevel: 3, description: 'Manage company assets' },
  'assets.delete': { defaultLevel: 4, description: 'Delete assets from system' },
  
  // Analytics features
  'analytics.basic': { defaultLevel: 3, description: 'Access basic analytics' },
  'analytics.advanced': { defaultLevel: 4, description: 'Access advanced analytics' },
  'analytics.export': { defaultLevel: 4, description: 'Export analytics data' },
  
  // System features
  'system.settings': { defaultLevel: 5, description: 'Manage system settings' },
  'system.users': { defaultLevel: 5, description: 'Manage system users' },
  'system.logs': { defaultLevel: 5, description: 'View system logs' },
  'system.permissions': { defaultLevel: 5, description: 'Manage system permissions' }
};

function authorizeFeature(featureName) {
  return async (req, res, next) => {
    try {
      if (!req.user || !req.user.id) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required'
        });
      }
      
      // Check if cache needs refresh (expired or not initialized)
      if (!permissionsCache.timestamp || 
          (Date.now() - permissionsCache.timestamp) > permissionsCache.ttl) {
        await refreshPermissionsCache();
      }
      
      // First check if user has specific permission overrides
      if (req.user.permissions && req.user.permissions[featureName]) {
        // User has explicit permission for this feature
        next();
        return;
      }
      
      // Check if the permission exists in cache, otherwise use default
      const permissionInfo = permissionsCache.permissions[featureName] || {
        permissionName: featureName,
        requiredLevel: defaultFeaturePermissions[featureName]?.defaultLevel || 5,
        description: defaultFeaturePermissions[featureName]?.description || 'Undocumented feature'
      };
      
      // If user has roles, check if any role grants this permission
      if (req.user.roles && Array.isArray(req.user.roles) && req.user.roles.length > 0) {
        for (const roleId of req.user.roles) {
          const role = permissionsCache.roles[roleId];
          if (role && role.permissions && 
              (role.permissions.includes(featureName) || role.permissions.includes('*'))) {
            // Role grants this permission
            next();
            return;
          }
        }
      }
      
      // Fall back to access level check
      if (req.user.accessLevel >= permissionInfo.requiredLevel) {
        next();
        return;
      }
      
      // If we get here, user doesn't have permission
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to access this feature'
      });
    } catch (error) {
      console.error('Error in authorizeFeature middleware:', error);
      return res.status(500).json({
        success: false,
        message: 'Internal server error while checking feature access'
      });
    }
  };
}

// Static helper method to check if a user can perform a specific feature action
// This now supports checking user-specific permissions and roles
authorizeFeature.canPerform = async (featureName, user) => {
  try {
    // If no user or missing critical data, deny access
    if (!user || (!user.accessLevel && !user.permissions && !user.roles)) {
      return false;
    }

    // Check if cache needs refresh (expired or not initialized)
    if (!permissionsCache.timestamp || 
        (Date.now() - permissionsCache.timestamp) > permissionsCache.ttl) {
      await refreshPermissionsCache();
    }
    
    // First check if user has specific permission overrides
    if (user.permissions && user.permissions[featureName]) {
      // User has explicit permission for this feature
      return true;
    }
    
    // Check if the permission exists in cache, otherwise use default
    const permissionInfo = permissionsCache.permissions[featureName] || {
      permissionName: featureName,
      requiredLevel: defaultFeaturePermissions[featureName]?.defaultLevel || 5,
      description: defaultFeaturePermissions[featureName]?.description || 'Undocumented feature'
    };
    
    // If user has roles, check if any role grants this permission
    if (user.roles && Array.isArray(user.roles) && user.roles.length > 0) {
      for (const roleId of user.roles) {
        const role = permissionsCache.roles[roleId];
        if (role && role.permissions && 
            (role.permissions.includes(featureName) || role.permissions.includes('*'))) {
          // Role grants this permission
          return true;
        }
      }
    }
    
    // Fall back to access level check
    return user.accessLevel >= permissionInfo.requiredLevel;
  } catch (error) {
    console.error('Error checking permission:', error);
    return false;
  }
};

// Helper to get all available permissions (for admin UI)
authorizeFeature.getAllPermissions = async () => {
  try {
    // Refresh cache if needed
    if (!permissionsCache.timestamp || 
        (Date.now() - permissionsCache.timestamp) > permissionsCache.ttl) {
      await refreshPermissionsCache();
    }
    
    // Combine default and custom permissions
    const allPermissions = { ...defaultFeaturePermissions };
    
    // Add any custom permissions from the database
    Object.values(permissionsCache.permissions).forEach(permission => {
      allPermissions[permission.permissionName] = {
        defaultLevel: permission.requiredLevel,
        description: permission.description,
        isCustom: true
      };
    });
    
    return allPermissions;
  } catch (error) {
    console.error('Error getting all permissions:', error);
    // Fall back to default permissions if error occurs
    return defaultFeaturePermissions;
  }
};

// Helper to create or update a permission
authorizeFeature.setPermission = async (permissionName, requiredLevel, description) => {
  try {
    const timestamp = new Date().toISOString();
    
    const permissionParams = {
      TableName: PERMISSIONS_TABLE,
      Item: {
        PK: `PERMISSION#${permissionName}`,
        SK: 'INFO',
        permissionName,
        requiredLevel,
        description,
        updatedAt: timestamp
      }
    };
    
    await dynamodb.put(permissionParams).promise();
    
    // Refresh the cache
    await refreshPermissionsCache();
    
    return true;
  } catch (error) {
    console.error('Error setting permission:', error);
    return false;
  }
};

// Helper to create or update a role
authorizeFeature.setRole = async (roleId, roleName, permissions, description) => {
  try {
    const timestamp = new Date().toISOString();
    
    const roleParams = {
      TableName: ROLES_TABLE,
      Item: {
        PK: `ROLE#${roleId}`,
        SK: 'INFO',
        roleId,
        roleName,
        permissions,
        description,
        updatedAt: timestamp
      }
    };
    
    await dynamodb.put(roleParams).promise();
    
    // Refresh the cache
    await refreshPermissionsCache();
    
    return true;
  } catch (error) {
    console.error('Error setting role:', error);
    return false;
  }
};

module.exports = authorizeFeature;

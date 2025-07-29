const dynamo = require('../services/db');

/**
 * Middleware to verify access level for specific operations
 * @param {Number} requiredLevel - The minimum access level required
 * @returns {Function} Express middleware
 */
function checkAccess(requiredLevel) {
  return async (req, res, next) => {
    try {
      if (!req.user || !req.user.id) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required'
        });
      }

      // Get user from database
      const userParams = {
        TableName: process.env.HRIS_USERS_TABLE,
        Key: { user_id: req.user.id }
      };

      const userResult = await dynamo.get(userParams).promise();
      const user = userResult.Item;

      if (!user) {
        return res.status(403).json({
          success: false,
          message: 'User not found'
        });
      }

      // Check if user has required access level
      if (user.access_level < requiredLevel) {
        return res.status(403).json({
          success: false,
          message: 'Insufficient access level'
        });
      }

      // Add user to request for future use
      req.userDetails = user;
      next();
    } catch (error) {
      console.error('Error checking access:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error'
      });
    }
  };
}

module.exports = checkAccess;

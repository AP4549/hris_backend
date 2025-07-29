/**
 * Helper module for determining approval authority for different types of requests
 */

/**
 * Check if a user has authority to approve a specific request type
 * 
 * @param {String} requestType - Type of request (leave, expense, training, etc.)
 * @param {Number} accessLevel - User's access level (1-5)
 * @param {Boolean} isSameDept - Whether user is in same department as requestor
 * @returns {Boolean} Whether user can approve this request type
 */
function canApprove(requestType, accessLevel, isSameDept) {
  // Admin (level 5) can approve anything
  if (accessLevel >= 5) {
    return true;
  }
  
  // HR (level 4) can approve most things
  if (accessLevel === 4) {
    // HR can approve all request types except high-value expenses
    if (requestType === 'expense-high') {
      return false;
    }
    return true;
  }
  
  // Department managers (level 3) can only approve for their own department
  if (accessLevel === 3 && isSameDept) {
    // Managers can approve standard request types
    switch (requestType) {
      case 'leave':
      case 'training':
      case 'equipment':
      case 'expense': // Standard expenses
      case 'document':
      case 'travel':
        return true;
      
      // Managers cannot approve these request types
      case 'expense-high': // High value expenses
      case 'policy-exception':
      case 'security-access':
      case 'salary-change':
        return false;
        
      default:
        // For unknown request types, default to false
        return false;
    }
  }
  
  // All other users cannot approve requests
  return false;
}

/**
 * Middleware to verify if a user has authority to approve a specific request
 * Use for protecting approval endpoints
 * 
 * @param {Object} req - Express request object
 * @param {String} employeeDepartment - Department of the requestor
 * @returns {Boolean} Whether user can approve this request
 */
async function checkAuthority(req, employeeDepartment) {
  try {
    if (!req.user || !req.user.id) {
      return false;
    }
    
    const userAccessLevel = req.user.accessLevel;
    const userDepartment = req.user.department;
    const isSameDept = userDepartment === employeeDepartment;
    
    // Admin (level 5) can approve anything
    if (userAccessLevel >= 5) {
      return true;
    }
    
    // HR (level 4) can approve across departments
    if (userAccessLevel === 4) {
      return true;
    }
    
    // Department managers (level 3) can only approve for their own department
    if (userAccessLevel === 3) {
      return isSameDept;
    }
    
    // All other users cannot approve requests
    return false;
  } catch (error) {
    console.error('Error checking approval authority:', error);
    return false;
  }
}

module.exports = {
  canApprove,
  checkAuthority
};

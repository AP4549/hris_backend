const express = require('express');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');
const checkAccess = require('../middleware/checkAccess');
const AWS = require('aws-sdk');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const dynamodb = new AWS.DynamoDB.DocumentClient();
const EMPLOYEES_TABLE = process.env.EMPLOYEES_TABLE;

// POST /employee - Admin adds a new employee
router.post('/', verifyToken, checkAccess(5), async (req, res) => {
  try {
    const {
      email,
      password,
      firstName,
      lastName,
      position,
      department,
      jobTitle,
      employeeType, // full-time, part-time, contract
      joiningDate,
      reportingManager,
      accessLevel,
      contactInfo,
      emergencyContact,
      bankDetails
    } = req.body;
    
    // Check if employee with this email already exists
    const checkParams = {
      TableName: EMPLOYEES_TABLE,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :email',
      ExpressionAttributeValues: {
        ':email': `EMAIL#${email.toLowerCase()}`
      }
    };
    
    const checkResult = await dynamodb.query(checkParams).promise();
    
    if (checkResult.Items && checkResult.Items.length > 0) {
      return res.status(400).json({ message: 'Employee with this email already exists' });
    }
    
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // Generate employee ID
    const employeeId = uuidv4();
    const timestamp = new Date().toISOString();
    
    const newEmployee = {
      PK: `EMPLOYEE#${employeeId}`,
      SK: `PROFILE`,
      employeeId,
      email: email.toLowerCase(),
      password: hashedPassword,
      firstName,
      lastName,
      fullName: `${firstName} ${lastName}`,
      position,
      department,
      jobTitle,
      employeeType,
      joiningDate,
      reportingManager,
      accessLevel: parseInt(accessLevel) || 1,
      contactInfo,
      emergencyContact,
      bankDetails,
      status: 'active',
      createdAt: timestamp,
      updatedAt: timestamp,
      createdBy: req.user.id,
      GSI1PK: `EMAIL#${email.toLowerCase()}`,
      GSI1SK: `EMPLOYEE`,
      GSI2PK: `DEPARTMENT#${department}`,
      GSI2SK: `EMPLOYEE#${lastName}#${firstName}`
    };
    
    await dynamodb.put({
      TableName: EMPLOYEES_TABLE,
      Item: newEmployee
    }).promise();
    
    // Remove password from response
    const responseEmployee = { ...newEmployee };
    delete responseEmployee.password;
    
    return res.status(201).json({
      message: 'Employee created successfully',
      employee: responseEmployee
    });
  } catch (error) {
    console.error('Error creating employee:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// PUT /employee/:id - Update employee profile
router.put('/:id', verifyToken, async (req, res) => {
  try {
    const employeeId = req.params.id;
    const currentUser = req.user;
    
    // Check if current user is the employee or has admin access
    if (currentUser.id !== employeeId && currentUser.accessLevel < 4) {
      return res.status(403).json({ message: 'Unauthorized to update this profile' });
    }
    
    const {
      firstName,
      lastName,
      contactInfo,
      emergencyContact,
      bankDetails,
      position,
      department,
      jobTitle,
      reportingManager,
      accessLevel,
      status
    } = req.body;
    
    // Get current employee data
    const getParams = {
      TableName: EMPLOYEES_TABLE,
      Key: {
        PK: `EMPLOYEE#${employeeId}`,
        SK: 'PROFILE'
      }
    };
    
    const employeeData = await dynamodb.get(getParams).promise();
    
    if (!employeeData.Item) {
      return res.status(404).json({ message: 'Employee not found' });
    }
    
    const updateExpressions = [];
    const expressionAttributeNames = {};
    const expressionAttributeValues = {};
    
    // Only admins can update these fields
    if (currentUser.accessLevel >= 4) {
      if (position) {
        updateExpressions.push('#position = :position');
        expressionAttributeNames['#position'] = 'position';
        expressionAttributeValues[':position'] = position;
      }
      
      if (department) {
        updateExpressions.push('#department = :department');
        expressionAttributeNames['#department'] = 'department';
        expressionAttributeValues[':department'] = department;
        
        // Also update GSI2PK if department changes
        updateExpressions.push('GSI2PK = :gsi2pk');
        expressionAttributeValues[':gsi2pk'] = `DEPARTMENT#${department}`;
      }
      
      if (jobTitle) {
        updateExpressions.push('#jobTitle = :jobTitle');
        expressionAttributeNames['#jobTitle'] = 'jobTitle';
        expressionAttributeValues[':jobTitle'] = jobTitle;
      }
      
      if (reportingManager) {
        updateExpressions.push('#reportingManager = :reportingManager');
        expressionAttributeNames['#reportingManager'] = 'reportingManager';
        expressionAttributeValues[':reportingManager'] = reportingManager;
      }
      
      if (accessLevel) {
        updateExpressions.push('#accessLevel = :accessLevel');
        expressionAttributeNames['#accessLevel'] = 'accessLevel';
        expressionAttributeValues[':accessLevel'] = parseInt(accessLevel);
      }
      
      if (status) {
        updateExpressions.push('#status = :status');
        expressionAttributeNames['#status'] = 'status';
        expressionAttributeValues[':status'] = status;
      }
    }
    
    // These fields can be updated by the employee or admin
    if (firstName) {
      updateExpressions.push('#firstName = :firstName');
      expressionAttributeNames['#firstName'] = 'firstName';
      expressionAttributeValues[':firstName'] = firstName;
      
      // Update fullName if firstName changes
      const lName = lastName || employeeData.Item.lastName;
      updateExpressions.push('#fullName = :fullName');
      expressionAttributeNames['#fullName'] = 'fullName';
      expressionAttributeValues[':fullName'] = `${firstName} ${lName}`;
      
      // Update GSI2SK if name changes
      updateExpressions.push('GSI2SK = :gsi2sk');
      expressionAttributeValues[':gsi2sk'] = `EMPLOYEE#${lName}#${firstName}`;
    }
    
    if (lastName) {
      updateExpressions.push('#lastName = :lastName');
      expressionAttributeNames['#lastName'] = 'lastName';
      expressionAttributeValues[':lastName'] = lastName;
      
      // Update fullName if lastName changes
      const fName = firstName || employeeData.Item.firstName;
      if (!updateExpressions.includes('#fullName = :fullName')) {
        updateExpressions.push('#fullName = :fullName');
        expressionAttributeNames['#fullName'] = 'fullName';
        expressionAttributeValues[':fullName'] = `${fName} ${lastName}`;
      }
      
      // Update GSI2SK if name changes
      if (!updateExpressions.includes('GSI2SK = :gsi2sk')) {
        updateExpressions.push('GSI2SK = :gsi2sk');
        expressionAttributeValues[':gsi2sk'] = `EMPLOYEE#${lastName}#${fName}`;
      }
    }
    
    if (contactInfo) {
      updateExpressions.push('#contactInfo = :contactInfo');
      expressionAttributeNames['#contactInfo'] = 'contactInfo';
      expressionAttributeValues[':contactInfo'] = contactInfo;
    }
    
    if (emergencyContact) {
      updateExpressions.push('#emergencyContact = :emergencyContact');
      expressionAttributeNames['#emergencyContact'] = 'emergencyContact';
      expressionAttributeValues[':emergencyContact'] = emergencyContact;
    }
    
    if (bankDetails) {
      updateExpressions.push('#bankDetails = :bankDetails');
      expressionAttributeNames['#bankDetails'] = 'bankDetails';
      expressionAttributeValues[':bankDetails'] = bankDetails;
    }
    
    // Add updatedAt to all updates
    updateExpressions.push('updatedAt = :updatedAt');
    expressionAttributeValues[':updatedAt'] = new Date().toISOString();
    
    if (updateExpressions.length === 0) {
      return res.status(400).json({ message: 'No fields to update' });
    }
    
    const updateParams = {
      TableName: EMPLOYEES_TABLE,
      Key: {
        PK: `EMPLOYEE#${employeeId}`,
        SK: 'PROFILE'
      },
      UpdateExpression: `SET ${updateExpressions.join(', ')}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW'
    };
    
    const updateResult = await dynamodb.update(updateParams).promise();
    
    // Remove password from response
    const responseEmployee = { ...updateResult.Attributes };
    delete responseEmployee.password;
    
    return res.status(200).json({
      message: 'Employee updated successfully',
      employee: responseEmployee
    });
  } catch (error) {
    console.error('Error updating employee:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// GET /employee/:id - Get employee profile
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const employeeId = req.params.id;
    const currentUser = req.user;
    
    // Determine access level - employees can only view their own profiles, managers can view their team
    let authorized = false;
    
    if (currentUser.id === employeeId) {
      authorized = true; // Own profile
    } else if (currentUser.accessLevel >= 3) {
      // Managers can view employees in their department or reporting to them
      authorized = true;
    }
    
    if (!authorized) {
      return res.status(403).json({ message: 'Unauthorized to view this profile' });
    }
    
    const params = {
      TableName: EMPLOYEES_TABLE,
      Key: {
        PK: `EMPLOYEE#${employeeId}`,
        SK: 'PROFILE'
      }
    };
    
    const result = await dynamodb.get(params).promise();
    
    if (!result.Item) {
      return res.status(404).json({ message: 'Employee not found' });
    }
    
    // Remove password from response
    const responseEmployee = { ...result.Item };
    delete responseEmployee.password;
    
    return res.status(200).json({
      message: 'Employee profile retrieved successfully',
      employee: responseEmployee
    });
  } catch (error) {
    console.error('Error retrieving employee profile:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// GET /employee - Get all employees (with filtering options)
router.get('/', verifyToken, checkAccess(3), async (req, res) => {
  try {
    const { department, status, employeeType } = req.query;
    
    let params = {
      TableName: EMPLOYEES_TABLE,
      FilterExpression: 'SK = :profile',
      ExpressionAttributeValues: {
        ':profile': 'PROFILE'
      }
    };
    
    // Add filters if provided
    const filterExpressions = ['SK = :profile'];
    
    if (department) {
      filterExpressions.push('department = :department');
      params.ExpressionAttributeValues[':department'] = department;
    }
    
    if (status) {
      filterExpressions.push('#status = :status');
      params.ExpressionAttributeValues[':status'] = status;
      if (!params.ExpressionAttributeNames) {
        params.ExpressionAttributeNames = {};
      }
      params.ExpressionAttributeNames['#status'] = 'status';
    }
    
    if (employeeType) {
      filterExpressions.push('employeeType = :employeeType');
      params.ExpressionAttributeValues[':employeeType'] = employeeType;
    }
    
    // Combine filter expressions
    params.FilterExpression = filterExpressions.join(' AND ');
    
    // For managers who aren't admins, limit to their department
    if (req.user.accessLevel < 5) {
      filterExpressions.push('department = :userDepartment');
      params.ExpressionAttributeValues[':userDepartment'] = req.user.department;
      params.FilterExpression = filterExpressions.join(' AND ');
    }
    
    const result = await dynamodb.scan(params).promise();
    
    // Remove passwords from response
    const employees = result.Items.map(employee => {
      const employeeData = { ...employee };
      delete employeeData.password;
      return employeeData;
    });
    
    return res.status(200).json({
      message: 'Employees retrieved successfully',
      employees
    });
  } catch (error) {
    console.error('Error retrieving employees:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// POST /employee/login - Login endpoint
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }
    
    const params = {
      TableName: EMPLOYEES_TABLE,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :email AND GSI1SK = :sk',
      ExpressionAttributeValues: {
        ':email': `EMAIL#${email.toLowerCase()}`,
        ':sk': 'EMPLOYEE'
      }
    };
    
    const result = await dynamodb.query(params).promise();
    
    if (!result.Items || result.Items.length === 0) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    
    const employee = result.Items[0];
    
    // Check if employee is active
    if (employee.status !== 'active') {
      return res.status(401).json({ message: 'Account is not active' });
    }
    
    // Compare passwords
    const isPasswordValid = await bcrypt.compare(password, employee.password);
    
    if (!isPasswordValid) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    
    // Generate JWT token
    const token = jwt.sign(
      {
        id: employee.employeeId,
        email: employee.email,
        name: employee.fullName,
        accessLevel: employee.accessLevel,
        department: employee.department,
        position: employee.position,
        permissions: employee.permissions || {},
        roles: employee.roles || []
      },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );
    
    // Remove password from response
    const responseEmployee = { ...employee };
    delete responseEmployee.password;
    
    return res.status(200).json({
      message: 'Login successful',
      token,
      employee: responseEmployee
    });
  } catch (error) {
    console.error('Error during login:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// DELETE /employee/:id - Offboard employee (Admin only)
router.delete('/:id', verifyToken, checkAccess(5), async (req, res) => {
  try {
    const employeeId = req.params.id;
    
    // Get employee first to check if exists
    const getParams = {
      TableName: EMPLOYEES_TABLE,
      Key: {
        PK: `EMPLOYEE#${employeeId}`,
        SK: 'PROFILE'
      }
    };
    
    const employeeData = await dynamodb.get(getParams).promise();
    
    if (!employeeData.Item) {
      return res.status(404).json({ message: 'Employee not found' });
    }
    
    // Instead of deleting, update status to 'inactive'
    const updateParams = {
      TableName: EMPLOYEES_TABLE,
      Key: {
        PK: `EMPLOYEE#${employeeId}`,
        SK: 'PROFILE'
      },
      UpdateExpression: 'SET #status = :status, terminationDate = :terminationDate, updatedAt = :updatedAt, updatedBy = :updatedBy',
      ExpressionAttributeNames: {
        '#status': 'status'
      },
      ExpressionAttributeValues: {
        ':status': 'inactive',
        ':terminationDate': new Date().toISOString(),
        ':updatedAt': new Date().toISOString(),
        ':updatedBy': req.user.id
      }
    };
    
    await dynamodb.update(updateParams).promise();
    
    return res.status(200).json({
      message: 'Employee offboarded successfully'
    });
  } catch (error) {
    console.error('Error offboarding employee:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// POST /employee/change-password - Change password endpoint
router.post('/change-password', verifyToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const employeeId = req.user.id;
    
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: 'Current password and new password are required' });
    }
    
    // Get employee data
    const params = {
      TableName: EMPLOYEES_TABLE,
      Key: {
        PK: `EMPLOYEE#${employeeId}`,
        SK: 'PROFILE'
      }
    };
    
    const result = await dynamodb.get(params).promise();
    
    if (!result.Item) {
      return res.status(404).json({ message: 'Employee not found' });
    }
    
    // Verify current password
    const isPasswordValid = await bcrypt.compare(currentPassword, result.Item.password);
    
    if (!isPasswordValid) {
      return res.status(401).json({ message: 'Current password is incorrect' });
    }
    
    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    
    // Update password
    const updateParams = {
      TableName: EMPLOYEES_TABLE,
      Key: {
        PK: `EMPLOYEE#${employeeId}`,
        SK: 'PROFILE'
      },
      UpdateExpression: 'SET password = :password, updatedAt = :updatedAt',
      ExpressionAttributeValues: {
        ':password': hashedPassword,
        ':updatedAt': new Date().toISOString()
      }
    };
    
    await dynamodb.update(updateParams).promise();
    
    return res.status(200).json({
      message: 'Password changed successfully'
    });
  } catch (error) {
    console.error('Error changing password:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

module.exports = router;

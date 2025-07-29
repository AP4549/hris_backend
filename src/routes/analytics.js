const express = require('express');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');
const checkAccess = require('../middleware/checkAccess');
const AWS = require('aws-sdk');

const dynamodb = new AWS.DynamoDB.DocumentClient();
const ANALYTICS_TABLE = process.env.ANALYTICS_TABLE;
const EMPLOYEES_TABLE = process.env.EMPLOYEES_TABLE;
const REQUESTS_TABLE = process.env.REQUESTS_TABLE;

// GET /analytics/dashboard - Get dashboard analytics
router.get('/dashboard', verifyToken, checkAccess(3), async (req, res) => {
  try {
    const { department } = req.query;
    const currentUser = req.user;
    
    // If user is not admin, restrict to their department
    const targetDepartment = (currentUser.accessLevel < 5 && !department) 
      ? currentUser.department 
      : department;
    
    // Prepare response object
    const dashboardData = {
      employeeStats: {},
      requestStats: {},
      recentActivities: []
    };
    
    // Get employee stats
    let employeeParams = {
      TableName: EMPLOYEES_TABLE,
      FilterExpression: 'SK = :profile',
      ExpressionAttributeValues: {
        ':profile': 'PROFILE'
      }
    };
    
    if (targetDepartment) {
      employeeParams.FilterExpression += ' AND department = :dept';
      employeeParams.ExpressionAttributeValues[':dept'] = targetDepartment;
    }
    
    const employeeResult = await dynamodb.scan(employeeParams).promise();
    
    // Calculate employee statistics
    const employees = employeeResult.Items || [];
    const activeEmployees = employees.filter(emp => emp.status === 'active');
    const newEmployees = activeEmployees.filter(emp => {
      const joiningDate = new Date(emp.joiningDate);
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      return joiningDate >= thirtyDaysAgo;
    });
    
    // Group employees by department
    const departmentCounts = {};
    activeEmployees.forEach(emp => {
      departmentCounts[emp.department] = (departmentCounts[emp.department] || 0) + 1;
    });
    
    // Group employees by position
    const positionCounts = {};
    activeEmployees.forEach(emp => {
      positionCounts[emp.position] = (positionCounts[emp.position] || 0) + 1;
    });
    
    dashboardData.employeeStats = {
      totalEmployees: activeEmployees.length,
      newEmployeesThisMonth: newEmployees.length,
      departmentDistribution: departmentCounts,
      positionDistribution: positionCounts
    };
    
    // Get request stats
    let requestParams = {
      TableName: REQUESTS_TABLE,
      IndexName: 'GSI2',
      KeyConditionExpression: 'begins_with(GSI2PK, :requestType)',
      ExpressionAttributeValues: {
        ':requestType': 'REQUEST#'
      }
    };
    
    const requestResult = await dynamodb.query(requestParams).promise();
    const requests = requestResult.Items || [];
    
    // Filter requests by department if needed
    let departmentFilteredRequests = requests;
    if (targetDepartment) {
      departmentFilteredRequests = requests.filter(req => req.employeeDepartment === targetDepartment);
    }
    
    // Calculate request statistics
    const pendingRequests = departmentFilteredRequests.filter(req => req.status === 'pending').length;
    const approvedRequests = departmentFilteredRequests.filter(req => req.status === 'approved').length;
    const rejectedRequests = departmentFilteredRequests.filter(req => req.status === 'rejected').length;
    
    // Group requests by type
    const requestsByType = {};
    departmentFilteredRequests.forEach(req => {
      requestsByType[req.type] = (requestsByType[req.type] || 0) + 1;
    });
    
    dashboardData.requestStats = {
      totalRequests: departmentFilteredRequests.length,
      pendingRequests,
      approvedRequests,
      rejectedRequests,
      requestsByType
    };
    
    // Get recent activities
    // Sort all requests by createdAt and get the 10 most recent
    const recentRequests = [...departmentFilteredRequests]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 10)
      .map(req => ({
        type: 'request',
        action: req.status === 'pending' ? 'submitted' : req.status,
        requestType: req.type,
        employeeName: req.employeeName,
        timestamp: req.createdAt,
        id: req.requestId
      }));
    
    dashboardData.recentActivities = recentRequests;
    
    return res.status(200).json({
      message: 'Dashboard data retrieved successfully',
      dashboard: dashboardData
    });
  } catch (error) {
    console.error('Error retrieving dashboard analytics:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// GET /analytics/headcount - Get headcount analytics
router.get('/headcount', verifyToken, checkAccess(4), async (req, res) => {
  try {
    const { department, startDate, endDate } = req.query;
    const currentUser = req.user;
    
    // If user is not admin, restrict to their department
    const targetDepartment = (currentUser.accessLevel < 5 && !department) 
      ? currentUser.department 
      : department;
    
    // Get employee data
    let employeeParams = {
      TableName: EMPLOYEES_TABLE,
      FilterExpression: 'SK = :profile',
      ExpressionAttributeValues: {
        ':profile': 'PROFILE'
      }
    };
    
    if (targetDepartment) {
      employeeParams.FilterExpression += ' AND department = :dept';
      employeeParams.ExpressionAttributeValues[':dept'] = targetDepartment;
    }
    
    const employeeResult = await dynamodb.scan(employeeParams).promise();
    const employees = employeeResult.Items || [];
    
    // Calculate headcount over time (by month for the past year)
    const headcountOverTime = {};
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    
    for (let i = 0; i <= 12; i++) {
      const date = new Date(oneYearAgo);
      date.setMonth(date.getMonth() + i);
      const yearMonth = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      
      headcountOverTime[yearMonth] = employees.filter(emp => {
        const joinDate = new Date(emp.joiningDate);
        return joinDate <= date && (!emp.terminationDate || new Date(emp.terminationDate) > date);
      }).length;
    }
    
    // Group by department
    const departmentDistribution = {};
    const activeEmployees = employees.filter(emp => emp.status === 'active');
    
    activeEmployees.forEach(emp => {
      departmentDistribution[emp.department] = (departmentDistribution[emp.department] || 0) + 1;
    });
    
    // Group by position
    const positionDistribution = {};
    activeEmployees.forEach(emp => {
      positionDistribution[emp.position] = (positionDistribution[emp.position] || 0) + 1;
    });
    
    const headcountData = {
      currentHeadcount: activeEmployees.length,
      headcountOverTime,
      departmentDistribution,
      positionDistribution
    };
    
    return res.status(200).json({
      message: 'Headcount analytics retrieved successfully',
      analytics: headcountData
    });
  } catch (error) {
    console.error('Error retrieving headcount analytics:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// GET /analytics/leave-stats - Get leave statistics
router.get('/leave-stats', verifyToken, checkAccess(3), async (req, res) => {
  try {
    const { department, year } = req.query;
    const currentUser = req.user;
    
    // If user is not admin, restrict to their department
    const targetDepartment = (currentUser.accessLevel < 5 && !department) 
      ? currentUser.department 
      : department;
    
    // Get leave requests
    const requestParams = {
      TableName: REQUESTS_TABLE,
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :requestType',
      ExpressionAttributeValues: {
        ':requestType': 'REQUEST#leave'
      }
    };
    
    const requestResult = await dynamodb.query(requestParams).promise();
    let leaveRequests = requestResult.Items || [];
    
    // Filter by department if needed
    if (targetDepartment) {
      leaveRequests = leaveRequests.filter(req => req.employeeDepartment === targetDepartment);
    }
    
    // Filter by year if specified
    const targetYear = year || new Date().getFullYear().toString();
    leaveRequests = leaveRequests.filter(req => {
      const startDate = new Date(req.startDate);
      return startDate.getFullYear().toString() === targetYear;
    });
    
    // Calculate leave statistics
    const approvedLeaves = leaveRequests.filter(req => req.status === 'approved');
    const pendingLeaves = leaveRequests.filter(req => req.status === 'pending');
    const rejectedLeaves = leaveRequests.filter(req => req.status === 'rejected');
    
    // Calculate leave days by month
    const leavesByMonth = Array(12).fill(0);
    
    approvedLeaves.forEach(leave => {
      const startDate = new Date(leave.startDate);
      const endDate = new Date(leave.endDate);
      
      // Simple calculation for demo purposes
      const durationDays = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1;
      const month = startDate.getMonth();
      
      leavesByMonth[month] += durationDays;
    });
    
    // Group by department
    const departmentLeaveDistribution = {};
    approvedLeaves.forEach(leave => {
      const dept = leave.employeeDepartment;
      const startDate = new Date(leave.startDate);
      const endDate = new Date(leave.endDate);
      const durationDays = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1;
      
      departmentLeaveDistribution[dept] = (departmentLeaveDistribution[dept] || 0) + durationDays;
    });
    
    const leaveStats = {
      totalLeaveRequests: leaveRequests.length,
      approvedLeaves: approvedLeaves.length,
      pendingLeaves: pendingLeaves.length,
      rejectedLeaves: rejectedLeaves.length,
      leavesByMonth,
      departmentLeaveDistribution,
      year: targetYear
    };
    
    return res.status(200).json({
      message: 'Leave statistics retrieved successfully',
      analytics: leaveStats
    });
  } catch (error) {
    console.error('Error retrieving leave statistics:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// GET /analytics/attrition - Get attrition trends
router.get('/attrition', verifyToken, checkAccess(5), async (req, res) => {
  try {
    const { department, startYear, endYear } = req.query;
    
    // Get employee data
    let employeeParams = {
      TableName: EMPLOYEES_TABLE,
      FilterExpression: 'SK = :profile',
      ExpressionAttributeValues: {
        ':profile': 'PROFILE'
      }
    };
    
    if (department) {
      employeeParams.FilterExpression += ' AND department = :dept';
      employeeParams.ExpressionAttributeValues[':dept'] = department;
    }
    
    const employeeResult = await dynamodb.scan(employeeParams).promise();
    const employees = employeeResult.Items || [];
    
    // Get employees with termination dates
    const terminatedEmployees = employees.filter(emp => emp.terminationDate);
    
    // Calculate attrition rate by year/month
    const currentYear = new Date().getFullYear();
    const startYearNum = startYear ? parseInt(startYear) : currentYear - 3;
    const endYearNum = endYear ? parseInt(endYear) : currentYear;
    
    const attritionByMonth = {};
    
    for (let year = startYearNum; year <= endYearNum; year++) {
      attritionByMonth[year] = Array(12).fill(0);
    }
    
    terminatedEmployees.forEach(emp => {
      const terminationDate = new Date(emp.terminationDate);
      const year = terminationDate.getFullYear();
      const month = terminationDate.getMonth();
      
      if (year >= startYearNum && year <= endYearNum) {
        attritionByMonth[year][month]++;
      }
    });
    
    // Calculate attrition rate by department
    const departmentAttrition = {};
    
    if (!department) {
      // Group all employees by department
      const departmentTotals = {};
      employees.forEach(emp => {
        departmentTotals[emp.department] = (departmentTotals[emp.department] || 0) + 1;
      });
      
      // Group terminated employees by department
      const departmentTerminations = {};
      terminatedEmployees.forEach(emp => {
        departmentTerminations[emp.department] = (departmentTerminations[emp.department] || 0) + 1;
      });
      
      // Calculate attrition rate per department
      Object.keys(departmentTotals).forEach(dept => {
        const terminations = departmentTerminations[dept] || 0;
        const total = departmentTotals[dept];
        departmentAttrition[dept] = {
          rate: (terminations / total) * 100,
          terminations,
          total
        };
      });
    }
    
    // Calculate overall attrition rate
    const totalEmployees = employees.length;
    const totalTerminated = terminatedEmployees.length;
    const overallAttritionRate = (totalTerminated / totalEmployees) * 100;
    
    const attritionData = {
      overallAttritionRate,
      attritionByMonth,
      departmentAttrition,
      timeRange: {
        startYear: startYearNum,
        endYear: endYearNum
      }
    };
    
    return res.status(200).json({
      message: 'Attrition trends retrieved successfully',
      analytics: attritionData
    });
  } catch (error) {
    console.error('Error retrieving attrition trends:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// GET /analytics/export - Export analytics data
router.get('/export', verifyToken, checkAccess(4), async (req, res) => {
  try {
    const { type, format, startDate, endDate } = req.query;
    
    if (!type || !format) {
      return res.status(400).json({ message: 'Type and format are required' });
    }
    
    // This would be a data export implementation
    // For now, we'll return a placeholder response
    
    const exportId = `export_${Date.now()}`;
    
    return res.status(200).json({
      message: 'Data export initiated successfully',
      exportId,
      downloadUrl: `https://example.com/exports/${exportId}.${format}`,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // 24 hours from now
    });
  } catch (error) {
    console.error('Error exporting analytics data:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

module.exports = router;

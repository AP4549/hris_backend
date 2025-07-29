const express = require('express');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');
const checkAccess = require('../middleware/checkAccess');
const AWS = require('aws-sdk');
const { v4: uuidv4 } = require('uuid');

const dynamodb = new AWS.DynamoDB.DocumentClient();
const REQUESTS_TABLE = process.env.REQUESTS_TABLE;

// POST /attendance/check-in - Employee check-in
router.post('/check-in', verifyToken, async (req, res) => {
  try {
    const { location, notes } = req.body;
    const employeeId = req.user.id;
    const employeeName = req.user.name;
    const employeeDepartment = req.user.department;
    
    // Check if employee has already checked in today
    const today = new Date();
    const dateString = today.toISOString().split('T')[0]; // YYYY-MM-DD
    
    const checkParams = {
      TableName: REQUESTS_TABLE,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :employee AND begins_with(GSI1SK, :checkInPrefix)',
      ExpressionAttributeValues: {
        ':employee': `EMPLOYEE#${employeeId}`,
        ':checkInPrefix': `REQUEST#attendance#${dateString}`
      }
    };
    
    const checkResult = await dynamodb.query(checkParams).promise();
    
    // Check if there's already a check-in without a check-out
    const existingAttendance = checkResult.Items?.find(item => 
      item.type === 'attendance' && 
      item.checkInTime && 
      !item.checkOutTime
    );
    
    if (existingAttendance) {
      return res.status(400).json({ message: 'You have already checked in today and not checked out' });
    }
    
    const attendanceId = uuidv4();
    const timestamp = new Date().toISOString();
    
    const newAttendance = {
      PK: `REQUEST#${attendanceId}`,
      SK: `EMPLOYEE#${employeeId}`,
      requestId: attendanceId,
      employeeId,
      employeeName,
      employeeDepartment,
      type: 'attendance',
      date: dateString,
      checkInTime: timestamp,
      checkInLocation: location,
      checkInNotes: notes,
      status: 'active', // active means checked-in but not checked-out
      createdAt: timestamp,
      updatedAt: timestamp,
      GSI1PK: `EMPLOYEE#${employeeId}`,
      GSI1SK: `REQUEST#attendance#${dateString}`,
      GSI2PK: `REQUEST#attendance`,
      GSI2SK: `DATE#${dateString}`
    };
    
    await dynamodb.put({
      TableName: REQUESTS_TABLE,
      Item: newAttendance
    }).promise();
    
    return res.status(201).json({
      message: 'Check-in recorded successfully',
      attendance: newAttendance
    });
  } catch (error) {
    console.error('Error recording check-in:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// POST /attendance/check-out - Employee check-out
router.post('/check-out', verifyToken, async (req, res) => {
  try {
    const { location, notes } = req.body;
    const employeeId = req.user.id;
    
    // Find the latest check-in without checkout
    const today = new Date();
    const dateString = today.toISOString().split('T')[0]; // YYYY-MM-DD
    
    const checkParams = {
      TableName: REQUESTS_TABLE,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :employee AND begins_with(GSI1SK, :checkInPrefix)',
      ExpressionAttributeValues: {
        ':employee': `EMPLOYEE#${employeeId}`,
        ':checkInPrefix': `REQUEST#attendance#${dateString}`
      }
    };
    
    const checkResult = await dynamodb.query(checkParams).promise();
    
    // Find active attendance record (has check-in but no check-out)
    const activeAttendance = checkResult.Items?.find(item => 
      item.type === 'attendance' && 
      item.checkInTime && 
      !item.checkOutTime
    );
    
    if (!activeAttendance) {
      return res.status(400).json({ message: 'No active check-in found for today' });
    }
    
    const timestamp = new Date().toISOString();
    
    // Calculate work duration in milliseconds
    const checkInTime = new Date(activeAttendance.checkInTime);
    const checkOutTime = new Date(timestamp);
    const durationMs = checkOutTime - checkInTime;
    
    // Convert to hours and minutes
    const durationHours = Math.floor(durationMs / (1000 * 60 * 60));
    const durationMinutes = Math.floor((durationMs % (1000 * 60 * 60)) / (1000 * 60));
    const durationFormatted = `${durationHours}h ${durationMinutes}m`;
    
    // Update the attendance record
    const updateParams = {
      TableName: REQUESTS_TABLE,
      Key: {
        PK: activeAttendance.PK,
        SK: activeAttendance.SK
      },
      UpdateExpression: 'SET checkOutTime = :checkOutTime, checkOutLocation = :checkOutLocation, checkOutNotes = :checkOutNotes, status = :status, durationMs = :durationMs, durationFormatted = :durationFormatted, updatedAt = :updatedAt',
      ExpressionAttributeValues: {
        ':checkOutTime': timestamp,
        ':checkOutLocation': location,
        ':checkOutNotes': notes,
        ':status': 'completed',
        ':durationMs': durationMs,
        ':durationFormatted': durationFormatted,
        ':updatedAt': timestamp
      },
      ReturnValues: 'ALL_NEW'
    };
    
    const updateResult = await dynamodb.update(updateParams).promise();
    
    return res.status(200).json({
      message: 'Check-out recorded successfully',
      attendance: updateResult.Attributes
    });
  } catch (error) {
    console.error('Error recording check-out:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// GET /attendance - Get attendance records for current user
router.get('/', verifyToken, async (req, res) => {
  try {
    const employeeId = req.user.id;
    const { startDate, endDate, status } = req.query;
    
    // Query user's attendance records
    const params = {
      TableName: REQUESTS_TABLE,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :employee AND begins_with(GSI1SK, :attendancePrefix)',
      ExpressionAttributeValues: {
        ':employee': `EMPLOYEE#${employeeId}`,
        ':attendancePrefix': 'REQUEST#attendance'
      }
    };
    
    const result = await dynamodb.query(params).promise();
    let attendanceRecords = result.Items || [];
    
    // Filter by date range if provided
    if (startDate && endDate) {
      attendanceRecords = attendanceRecords.filter(record => {
        return record.date >= startDate && record.date <= endDate;
      });
    }
    
    // Filter by status if provided
    if (status) {
      attendanceRecords = attendanceRecords.filter(record => record.status === status);
    }
    
    // Sort by date descending (newest first)
    attendanceRecords.sort((a, b) => {
      return new Date(b.date) - new Date(a.date);
    });
    
    return res.status(200).json({
      message: 'Attendance records retrieved successfully',
      attendance: attendanceRecords
    });
  } catch (error) {
    console.error('Error retrieving attendance records:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// GET /attendance/employee/:id - Get attendance for specific employee (managers only)
router.get('/employee/:id', verifyToken, checkAccess(3), async (req, res) => {
  try {
    const employeeId = req.params.id;
    const { startDate, endDate } = req.query;
    
    // Verify the employee exists and user has access
    const employeeParams = {
      TableName: process.env.EMPLOYEES_TABLE,
      Key: {
        PK: `EMPLOYEE#${employeeId}`,
        SK: 'PROFILE'
      }
    };
    
    const employeeResult = await dynamodb.get(employeeParams).promise();
    
    if (!employeeResult.Item) {
      return res.status(404).json({ message: 'Employee not found' });
    }
    
    // Non-admin managers can only view employees in their department
    if (req.user.accessLevel < 5 && employeeResult.Item.department !== req.user.department) {
      return res.status(403).json({ message: 'Unauthorized to access this employee\'s attendance' });
    }
    
    // Query employee's attendance records
    const params = {
      TableName: REQUESTS_TABLE,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :employee AND begins_with(GSI1SK, :attendancePrefix)',
      ExpressionAttributeValues: {
        ':employee': `EMPLOYEE#${employeeId}`,
        ':attendancePrefix': 'REQUEST#attendance'
      }
    };
    
    const result = await dynamodb.query(params).promise();
    let attendanceRecords = result.Items || [];
    
    // Filter by date range if provided
    if (startDate && endDate) {
      attendanceRecords = attendanceRecords.filter(record => {
        return record.date >= startDate && record.date <= endDate;
      });
    }
    
    // Sort by date descending (newest first)
    attendanceRecords.sort((a, b) => {
      return new Date(b.date) - new Date(a.date);
    });
    
    return res.status(200).json({
      message: 'Employee attendance records retrieved successfully',
      employeeName: employeeResult.Item.fullName,
      attendance: attendanceRecords
    });
  } catch (error) {
    console.error('Error retrieving employee attendance records:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// GET /attendance/department - Get attendance for a department (managers only)
router.get('/department', verifyToken, checkAccess(3), async (req, res) => {
  try {
    const { department, date } = req.query;
    
    // If not admin, can only view own department
    const targetDepartment = req.user.accessLevel < 5 ? req.user.department : (department || req.user.department);
    
    // Default to today if no date specified
    const targetDate = date || new Date().toISOString().split('T')[0];
    
    // Query attendance records by department and date
    const params = {
      TableName: REQUESTS_TABLE,
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :type AND begins_with(GSI2SK, :datePrefix)',
      FilterExpression: 'employeeDepartment = :department',
      ExpressionAttributeValues: {
        ':type': 'REQUEST#attendance',
        ':datePrefix': `DATE#${targetDate}`,
        ':department': targetDepartment
      }
    };
    
    const result = await dynamodb.query(params).promise();
    const attendanceRecords = result.Items || [];
    
    // Get list of all employees in the department
    const employeeParams = {
      TableName: process.env.EMPLOYEES_TABLE,
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :deptKey',
      ExpressionAttributeValues: {
        ':deptKey': `DEPARTMENT#${targetDepartment}`
      }
    };
    
    const employeeResult = await dynamodb.query(employeeParams).promise();
    const departmentEmployees = employeeResult.Items || [];
    const activeEmployees = departmentEmployees.filter(emp => emp.status === 'active');
    
    // Calculate attendance statistics
    const presentEmployeeIds = new Set(attendanceRecords.map(rec => rec.employeeId));
    const presentCount = presentEmployeeIds.size;
    const absentCount = activeEmployees.length - presentCount;
    const attendanceRate = activeEmployees.length > 0 
      ? (presentCount / activeEmployees.length) * 100 
      : 0;
    
    return res.status(200).json({
      message: 'Department attendance retrieved successfully',
      department: targetDepartment,
      date: targetDate,
      statistics: {
        totalEmployees: activeEmployees.length,
        present: presentCount,
        absent: absentCount,
        attendanceRate: attendanceRate.toFixed(2) + '%'
      },
      attendance: attendanceRecords
    });
  } catch (error) {
    console.error('Error retrieving department attendance:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// PUT /attendance/:id - Update attendance record (managers only)
router.put('/:id', verifyToken, checkAccess(3), async (req, res) => {
  try {
    const attendanceId = req.params.id;
    const { checkInTime, checkOutTime, notes } = req.body;
    
    // Get attendance record
    const attendanceParams = {
      TableName: REQUESTS_TABLE,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: {
        ':pk': `REQUEST#${attendanceId}`
      }
    };
    
    const attendanceResult = await dynamodb.query(attendanceParams).promise();
    
    if (!attendanceResult.Items || attendanceResult.Items.length === 0) {
      return res.status(404).json({ message: 'Attendance record not found' });
    }
    
    const attendance = attendanceResult.Items[0];
    
    // Check if manager has access to this department
    if (req.user.accessLevel < 5 && attendance.employeeDepartment !== req.user.department) {
      return res.status(403).json({ message: 'Unauthorized to update this attendance record' });
    }
    
    // Calculate new duration if both times are provided
    let durationMs, durationFormatted;
    if (checkInTime && checkOutTime) {
      const inTime = new Date(checkInTime);
      const outTime = new Date(checkOutTime);
      durationMs = outTime - inTime;
      
      const durationHours = Math.floor(durationMs / (1000 * 60 * 60));
      const durationMinutes = Math.floor((durationMs % (1000 * 60 * 60)) / (1000 * 60));
      durationFormatted = `${durationHours}h ${durationMinutes}m`;
    }
    
    // Build update expression
    const updateExpressions = [];
    const expressionAttributeValues = {};
    
    if (checkInTime) {
      updateExpressions.push('checkInTime = :checkInTime');
      expressionAttributeValues[':checkInTime'] = checkInTime;
    }
    
    if (checkOutTime) {
      updateExpressions.push('checkOutTime = :checkOutTime');
      expressionAttributeValues[':checkOutTime'] = checkOutTime;
      updateExpressions.push('status = :status');
      expressionAttributeValues[':status'] = 'completed';
    }
    
    if (notes) {
      updateExpressions.push('managerNotes = :notes');
      expressionAttributeValues[':notes'] = notes;
    }
    
    if (durationMs) {
      updateExpressions.push('durationMs = :durationMs');
      expressionAttributeValues[':durationMs'] = durationMs;
      
      updateExpressions.push('durationFormatted = :durationFormatted');
      expressionAttributeValues[':durationFormatted'] = durationFormatted;
    }
    
    if (updateExpressions.length === 0) {
      return res.status(400).json({ message: 'No fields to update' });
    }
    
    // Always update these fields
    updateExpressions.push('updatedAt = :updatedAt');
    expressionAttributeValues[':updatedAt'] = new Date().toISOString();
    
    updateExpressions.push('updatedBy = :updatedBy');
    expressionAttributeValues[':updatedBy'] = req.user.id;
    
    updateExpressions.push('updatedByName = :updatedByName');
    expressionAttributeValues[':updatedByName'] = req.user.name;
    
    const updateParams = {
      TableName: REQUESTS_TABLE,
      Key: {
        PK: `REQUEST#${attendanceId}`,
        SK: attendance.SK
      },
      UpdateExpression: `SET ${updateExpressions.join(', ')}`,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW'
    };
    
    const updateResult = await dynamodb.update(updateParams).promise();
    
    return res.status(200).json({
      message: 'Attendance record updated successfully',
      attendance: updateResult.Attributes
    });
  } catch (error) {
    console.error('Error updating attendance record:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// GET /attendance/stats - Get attendance statistics (managers only)
router.get('/stats', verifyToken, checkAccess(3), async (req, res) => {
  try {
    const { department, startDate, endDate } = req.query;
    
    // If not admin, can only view own department
    const targetDepartment = req.user.accessLevel < 5 ? req.user.department : (department || req.user.department);
    
    // Default to last 30 days if dates not specified
    const now = new Date();
    const defaultStartDate = new Date();
    defaultStartDate.setDate(now.getDate() - 30);
    
    const start = startDate || defaultStartDate.toISOString().split('T')[0];
    const end = endDate || now.toISOString().split('T')[0];
    
    // Get all attendance records for department in date range
    const attendanceRecords = [];
    
    // Since we can't query directly by date range, we'll need to get all attendance records
    // and filter them in memory. In a real application, this would be optimized.
    const params = {
      TableName: REQUESTS_TABLE,
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :type',
      FilterExpression: 'employeeDepartment = :department',
      ExpressionAttributeValues: {
        ':type': 'REQUEST#attendance',
        ':department': targetDepartment
      }
    };
    
    const result = await dynamodb.query(params).promise();
    const allRecords = result.Items || [];
    
    // Filter by date range
    const filteredRecords = allRecords.filter(record => {
      return record.date >= start && record.date <= end;
    });
    
    // Get all active employees in department
    const employeeParams = {
      TableName: process.env.EMPLOYEES_TABLE,
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :deptKey',
      FilterExpression: '#status = :active',
      ExpressionAttributeNames: {
        '#status': 'status'
      },
      ExpressionAttributeValues: {
        ':deptKey': `DEPARTMENT#${targetDepartment}`,
        ':active': 'active'
      }
    };
    
    const employeeResult = await dynamodb.query(employeeParams).promise();
    const departmentEmployees = employeeResult.Items || [];
    
    // Calculate statistics
    const attendanceByEmployee = {};
    const attendanceByDate = {};
    
    // Initialize employee attendance records
    departmentEmployees.forEach(emp => {
      attendanceByEmployee[emp.employeeId] = {
        employeeId: emp.employeeId,
        employeeName: emp.fullName,
        presentDays: 0,
        absentDays: 0,
        lateCheckins: 0,
        earlyCheckouts: 0,
        totalWorkHours: 0
      };
    });
    
    // Calculate working days in date range
    const workingDays = getWorkingDaysCount(start, end);
    
    // Process attendance records
    filteredRecords.forEach(record => {
      const employeeId = record.employeeId;
      const date = record.date;
      
      // Skip if employee not in active employees list
      if (!attendanceByEmployee[employeeId]) {
        return;
      }
      
      // Count this as present day
      attendanceByEmployee[employeeId].presentDays++;
      
      // Track attendance by date
      if (!attendanceByDate[date]) {
        attendanceByDate[date] = {
          date,
          present: 0,
          absent: 0,
          attendance_rate: 0
        };
      }
      attendanceByDate[date].present++;
      
      // Calculate total work hours if record is complete
      if (record.checkInTime && record.checkOutTime && record.durationMs) {
        const hoursWorked = record.durationMs / (1000 * 60 * 60);
        attendanceByEmployee[employeeId].totalWorkHours += hoursWorked;
        
        // Check for late check-in (after 9 AM)
        const checkInTime = new Date(record.checkInTime);
        if (checkInTime.getHours() >= 9 && checkInTime.getMinutes() > 0) {
          attendanceByEmployee[employeeId].lateCheckins++;
        }
        
        // Check for early check-out (before 5 PM)
        const checkOutTime = new Date(record.checkOutTime);
        if (checkOutTime.getHours() < 17) {
          attendanceByEmployee[employeeId].earlyCheckouts++;
        }
      }
    });
    
    // Calculate absent days for each employee
    Object.keys(attendanceByEmployee).forEach(employeeId => {
      const employee = attendanceByEmployee[employeeId];
      employee.absentDays = workingDays - employee.presentDays;
      employee.attendanceRate = ((employee.presentDays / workingDays) * 100).toFixed(2) + '%';
      employee.avgWorkHoursPerDay = employee.presentDays > 0 
        ? (employee.totalWorkHours / employee.presentDays).toFixed(2) 
        : 0;
    });
    
    // Calculate overall department statistics
    const departmentStats = {
      totalEmployees: departmentEmployees.length,
      workingDays,
      averageAttendanceRate: 0,
      averageWorkHours: 0
    };
    
    // Calculate attendance rate for each date
    Object.keys(attendanceByDate).forEach(date => {
      const dateStats = attendanceByDate[date];
      dateStats.absent = departmentEmployees.length - dateStats.present;
      dateStats.attendance_rate = ((dateStats.present / departmentEmployees.length) * 100).toFixed(2) + '%';
    });
    
    // Calculate department averages
    let totalPresent = 0;
    let totalWorkHours = 0;
    
    Object.values(attendanceByEmployee).forEach(employee => {
      totalPresent += employee.presentDays;
      totalWorkHours += employee.totalWorkHours;
    });
    
    const totalPossibleAttendance = departmentEmployees.length * workingDays;
    departmentStats.averageAttendanceRate = totalPossibleAttendance > 0
      ? ((totalPresent / totalPossibleAttendance) * 100).toFixed(2) + '%'
      : '0%';
      
    departmentStats.averageWorkHours = totalPresent > 0
      ? (totalWorkHours / totalPresent).toFixed(2)
      : 0;
    
    return res.status(200).json({
      message: 'Attendance statistics retrieved successfully',
      department: targetDepartment,
      dateRange: { startDate: start, endDate: end },
      departmentStats,
      employeeStats: Object.values(attendanceByEmployee),
      dailyStats: Object.values(attendanceByDate).sort((a, b) => a.date.localeCompare(b.date))
    });
  } catch (error) {
    console.error('Error retrieving attendance statistics:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// Helper function to count working days between two dates
function getWorkingDaysCount(startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  
  let count = 0;
  const currentDate = new Date(start);
  
  while (currentDate <= end) {
    // Check if it's a weekday (Monday-Friday)
    const dayOfWeek = currentDate.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      count++;
    }
    
    // Move to next day
    currentDate.setDate(currentDate.getDate() + 1);
  }
  
  return count;
}

module.exports = router;

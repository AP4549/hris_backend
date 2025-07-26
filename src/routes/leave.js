const express = require('express');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');
const checkAccess = require('../middleware/checkAccess');
const dynamo = require('../services/db');  

// POST /leave/request → Employee submits leave
router.post('/request', verifyToken, async (req, res) => {
    // Logic to submit leave request
    try{
        const {startDate, endDate, leaveType, reason} = req.body;
        const employeeId = req.user.id;

        if(!startDate || !endDate || !leaveType || !reason){
            return res.status(400).json({
                success: false,
                message: 'Some required fields are missing: startDate, endDate, leaveType, reason. Please fill all the required fields.'
            });
        }

        const start = new Date(startDate);
        const end = new Date(endDate);
        const today = new Date();

        if(start <= today){
            return res.status(400).json({
                success: false,
                message: 'Start date cannot be today or in the past. Please select a valid date.'
            });
        }

        if(end <= start){
            return res.status(400).json({
                success: false,
                message: 'End date must be after start date. Please select a valid date.'
            });
        }

        const leaveDays = getDateDiffInDays(start, end);
        const leaveBalance = await getLeaveBalance(employeeId, leaveType);

        if(leaveBalance < leaveDays){
            return res.status(400).json({
                success: false,
                message: `Insufficient ${leaveType} leave balance. Available: ${leaveBalance} days, Requested: ${leaveDays} days.`
            });
        }

        const leaveRequest = {
            id: `leave_${Date.now()}_${employeeId}`,
            employeeId,
            startDate: start.toISOString(),
            endDate: end.toISOString(),
            leaveType,
            reason,
            leaveDays,
            status: 'pending',
            submittedAt: new Date().toISOString(),
            managerId: req.user.managerId || null
        };

        await dynamo.put({
            TableName: 'LeaveRequests',
            Item: leaveRequest
        }).promise();

        res.status(201).json({
            success: true,
            message: 'Leave request submitted successfully',
            data: leaveRequest
        });
    }catch (error){
        console.error('Error while submitting leave request:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});

// PUT /leave/:id/approve → Manager approves
router.put('/:id/approve', verifyToken, checkAccess(4), async (req, res) => {
    // Logic to approve leave request
    try{
        const {id} = req.params;
        const {status, comments} = req.body;
        const managerId = req.user.id;

        if(!status || !['approved', 'rejected'].includes(status)){
            return res.status(400).json({
                success: false,
                message: 'Invalid status. Must be "approved" or "rejected".'
            });
        }

        const result = await dynamo.get({
            TableName: 'LeaveRequests',
            Key: {id}
        }).promise();

        if(!result.Item){
            return res.status(404).json({
                success: false,
                message: 'Leave request not found'
            });
        }

        const leaveRequest = result.Item;

        if(leaveRequest.status !== 'pending'){
            return res.status(403).json({
                success: false,
                message: 'Leave request is not pending. Cannot approve or reject'
            });
        }

        const updateParams = {
            TableName: 'LeaveRequests',
            Key: { id },
            UpdateExpression: 'SET #status = :status, #approvedBy = :approvedBy, #approvedAt = :approvedAt, #comments = :comments',
            ExpressionAttributeNames: {
                '#status': 'status',
                '#approvedBy': 'approvedBy',
                '#approvedAt': 'approvedAt',
                '#comments': 'comments'
            },
            ExpressionAttributeValues: {
                ':status': status,
                ':approvedBy': managerId,
                ':approvedAt': new Date().toISOString(),
                ':comments': comments || ''
            }
        };

        await dynamo.update(updateParams).promise();

        if(status === 'approved'){
            await updateLeaveBalance(employeeId, leaveRequest.leaveType, leaveRequest.leaveDays);
        }

        res.json({
            success: true,
            message: `Leave request approved successfully, status ${status}`,
            data: {id, status, approvedBy: managerId }
        });
    }catch (error){
        console.error('Error while approving leave request:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});

// GET /leave/history/:empId → Fetch leave history
router.get('/history/:empId', verifyToken, async (req, res) => {
    // Logic to fetch leave history
    try{
        const {empId} = req.params;
        const requestingUserId = req.user.id;

        if(req.user.role !== 'admin' && requestingUserId !== empId){
            return res.status(403).json({
                success: false,
                message: 'Access denied'
            });
        }

        const result = await dynamo.query({
            TableName: 'LeaveRequests',
            IndexName: 'EmployeeIdIndex',
            KeyConditionExpression: 'employeeId = :empId',
            ExpressionAttributeValues: {
                ':empId': empId
            }
        }).promise();

        const leaveBalance = await getLeaveBalance(empId);

        res.json({
            success: true,
            data:{
                leaveRequest: result.Items || [],
                leaveBalance
            }
        }); 
    }catch (error){
        console.error('Error fetching leave history:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});

// POST /attendance/log → Punch in/out
router.post('/attendance/log', verifyToken, async (req, res) => {
    // Logic to log attendance
    try {
    const {type, location, notes} = req.body;
    const employeeId = req.user.id;

    if(!type || !['in', 'out'].includes(type)){
        return res.status(400).json({
            success: false,
            message: 'Invalid attendance type. Must be "in" or "out".'
        });
    }

    const now = new Date();
    const today = now.toISOString().split('T')[0];

    const existingLog = await dynamo.query({
        TableName: 'AttendanceLogs',
        IndexName: 'EmployeeDateIndex',
        KeyConditionExpression: 'employeeId = :empId AND #date = :date',
        ExpressionAttributeNames: {
            '#date': 'date'
        },
        ExpressionAttributeValues: {
            ':empId': employeeId,
            ':date': today
        }
    }).promise();

    const todayLogs = existingLog.Items || [];

    if(type === 'in'){
        const alreadyIn = todayLogs.some(Log => Log.type === 'in');
        if(alreadyIn) {
            return res.status(400).json({   
                success: false,
                message: 'You have already punched in today.'
            });
        }
    }else{
        const punchedIN = todayLogs.some(Log => Log.type === 'in')
        const alreadyPunchedOut = todayLogs.some(log => log.type === 'out');

        if(!punchedIN){
            return res.status(400).json({
                success: false,
                message: 'You have not punched in today. Please punch in first before punching out.'
            });
        }

        if(alreadyPunchedOut){
            return res.status(400).json({
                success: false,
                message: 'You have already punched out today.'
            });
        }
    }

    const attendanceLog = {
        id: `attendance_${Date.now()}_${employeeId}`,
        employeeId,
        type,
        date: today,
        timestamp: now.toISOString(),
        location: location || null,
        notes: notes || null
    };

    await dynamo.put({
        TableName: 'AttendanceLogs',
        Item: attendanceLog
    }).promise();

    res.status(201).json({
        success: true,
        message: `Attendance punched ${type}`,
        data: attendanceLog
    });

} catch (error){
        console.error('Error while leave history', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});


//Helper Functions

function getDateDiffInDays(startDate, endDate) {
    // Remove the time portion by setting time to 00:00:00
    const start = new Date(startDate.setHours(0, 0, 0, 0));
    const end = new Date(endDate.setHours(0, 0, 0, 0));
  
    const diffInMs = end - start;
    const diffInDays = diffInMs / (1000 * 60 * 60 * 24);
  
    return diffInDays;
}

async function getLeaveBalance(employeeId, leaveType = null) {
    try {
        const result = await dynamo.get({
            TableName: 'LeaveBalances',
            Key: { employeeId }
        }).promise();

        if (!result.Item) {
            // Initialize leave balance if not exists
            const defaultBalance = {
                employeeId,
                annual: 20,
                sick: 10,
                personal: 5,
                maternity: 90,
                paternity: 10
            };
            
            await dynamo.put({
                TableName: 'LeaveBalances',
                Item: defaultBalance
            }).promise();
            
            return leaveType ? defaultBalance[leaveType] : defaultBalance;
        }

        return leaveType ? result.Item[leaveType] : result.Item;
    } catch (error) {
        console.error('Error getting leave balance:', error);
        throw error;
    }
}

async function updateLeaveBalance(employeeId, leaveType, daysUsed) {
    try {
        const updateParams = {
            TableName: 'LeaveBalances',
            Key: { employeeId },
            UpdateExpression: 'SET #leaveType = #leaveType - :daysUsed',
            ExpressionAttributeNames: {
                '#leaveType': leaveType
            },
            ExpressionAttributeValues: {
                ':daysUsed': daysUsed
            }
        };

        await dynamo.update(updateParams).promise();
    } catch (error) {
        console.error('Error updating leave balance:', error);
        throw error;
    }
}

module.exports = router;

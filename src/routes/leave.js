const express = require('express');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');
const checkAccess = require('../middleware/checkAccess');
const dynamo = require('../services/db');  

// POST /leave/request → Employee submits leave
router.post('/request', verifyToken, async (req, res) => {
    // Logic to submit leave request
    try{
        //GET REQUEST BODY
        const {startDate, endDate, leaveType, reason} = req.body;
        const employeeId = req.user.id;

        //CHECK IF ALL REQUIRED FIELDS ARE PRESENT
        if(!startDate || !endDate || !leaveType || !reason){
            return res.status(400).json({
                success: false,
                message: 'Some required fields are missing: startDate, endDate, leaveType, reason. Please fill all the required fields.'
            });
        }

        //CONVERT STRING TO DATE OBJECT
        const start = new Date(startDate);
        const end = new Date(endDate);
        const today = new Date();

        //CHECK IF START DATE IS TODAY...
        if(start <= today){
            return res.status(400).json({
                success: false,
                message: 'Start date cannot be today or in the past. Please select a valid date.'
            });
        }

        //CHECK IF END DATE IS BEFORE START DATE
        if(end <= start){
            return res.status(400).json({
                success: false,
                message: 'End date must be after start date. Please select a valid date.'
            });
        }

        //CALCULATE LEAVE DAYS
        const leaveDays = getDateDiffInDays(start, end);
        const leaveBalance = await getLeaveBalance(employeeId, leaveType);
        
        //CHECK IF LEAVE BALANCE IS SUFFICIENT
        if(leaveBalance < leaveDays){
            return res.status(400).json({
                success: false,
                message: `Insufficient ${leaveType} leave balance. Available: ${leaveBalance} days, Requested: ${leaveDays} days.`
            });
        }

        //CREATE LEAVE REQUEST OBJECT
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

        //STORE LEAVE REQUEST IN DYNAMODB
        await dynamo.put({
            TableName: 'LeaveRequests',
            Item: leaveRequest
        }).promise();

        //RETURN SUCCESS RESPONSE
        res.status(201).json({
            success: true,
            message: 'Leave request submitted successfully',
            data: leaveRequest
        });
    }catch (error){
        //HANDLING ERRORS
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
        //GET REQUEST BODY
        const {id} = req.params;
        const {status, comments} = req.body;
        const managerId = req.user.id;

        //CHECK IF STATUS IS VALID
        if(!status || !['approved', 'rejected'].includes(status)){
            return res.status(400).json({
                success: false,
                message: 'Invalid status. Must be "approved" or "rejected".'
            });
        }

        //GET LEAVE REQUEST FROM DYNAMODB
        const result = await dynamo.get({
            TableName: 'LeaveRequests',
            Key: {id}
        }).promise();

        //CHECK IF LEAVE REQUEST EXISTS
        if(!result.Item){
            return res.status(404).json({
                success: false,
                message: 'Leave request not found'
            });
        }

        const leaveRequest = result.Item;

        //CHECK IF MANAGER HAS ACCESS TO APPROVE LEAVE REQUEST
        if (leaveRequest.managerId && leaveRequest.managerId !== managerId) {
            return res.status(403).json({
              success: false,
              message: 'You are not authorized to approve this leave request.'
            });
        }

        //CHECK IF LEAVE REQUEST IS PENDING
        if(leaveRequest.status !== 'pending'){
            return res.status(403).json({
                success: false,
                message: 'Leave request is not pending. Cannot approve or reject'
            });
        }

        //UPDATE LEAVE REQUEST STATUS
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

        //UPDATE LEAVE BALANCE IF LEAVE IS APPROVED
        if(status === 'approved'){
            await updateLeaveBalance(employeeId, leaveRequest.leaveType, leaveRequest.leaveDays);
        }

        //RETURN SUCCESS RESPONSE
        res.json({
            success: true,
            message: `Leave request approved successfully, status ${status}`,
            data: {id, status, approvedBy: managerId }
        });
    }catch (error){
        //HANDLING ERRORS
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
        //GET REQUEST BODY
        const {empId} = req.params;
        const requestingUserId = req.user.id;

        //CHECK IF USER HAS ACCESS TO FETCH LEAVE HISTORY
        if(req.user.role !== 'admin' && requestingUserId !== empId){
            return res.status(403).json({
                success: false,
                message: 'Access denied'
            });
        }

        //GET LEAVE REQUESTS FROM DYNAMODB
        const result = await dynamo.query({
            TableName: 'LeaveRequests',
            IndexName: 'EmployeeIdIndex',
            KeyConditionExpression: 'employeeId = :empId',
            ExpressionAttributeValues: {
                ':empId': empId
            }
        }).promise();

        //GET LEAVE BALANCE
        const leaveBalance = await getLeaveBalance(empId);

        //RETURN SUCCESS RESPONSE
        res.json({
            success: true,
            data:{
                leaveRequest: result.Items || [],
                leaveBalance
            }
        }); 
    }catch (error){
        //HANDLING ERRORS
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
    //GET REQUEST BODY
    const {type, location, notes} = req.body;
    const employeeId = req.user.id;

    //CHECK IF ATTENDANCE TYPE IS VALID
    if(!type || !['in', 'out'].includes(type)){
        return res.status(400).json({
            success: false,
            message: 'Invalid attendance type. Must be "in" or "out".'
        });
    }

    //GET CURRENT DATE
    const now = new Date();
    const today = now.toISOString().split('T')[0];

    //CHECK IF EMPLOYEE HAS ALREADY PUNCHED IN OR OUT TODAY
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

    //GET TODAY'S ATTENDANCE LOGS
    const todayLogs = existingLog.Items || [];

    //CHECK IF EMPLOYEE HAS PUNCHED IN OR OUT TODAY 
    if(type === 'in'){
        //CHECK IF EMPLOYEE HAS PUNCHED IN TODAY
        const alreadyIn = todayLogs.some(Log => Log.type === 'in');
        if(alreadyIn) {
            return res.status(400).json({   
                success: false,
                message: 'You have already punched in today.'
            });
        }
    }else{
        //CHECK IF EMPLOYEE HAS PUNCHED OUT TODAY
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

    //CREATE ATTENDANCE LOG OBJECT
    const attendanceLog = {
        id: `attendance_${Date.now()}_${employeeId}`,
        employeeId,
        type,
        date: today,
        timestamp: now.toISOString(),
        location: location || null,
        notes: notes || null
    };

    //STORE ATTENDANCE LOG IN DYNAMODB
    await dynamo.put({
        TableName: 'AttendanceLogs',
        Item: attendanceLog
    }).promise();

    //RETURN SUCCESS RESPONSE
    res.status(201).json({
        success: true,
        message: `Attendance punched ${type}`,
        data: attendanceLog
    });

} catch (error){
        //HANDLING ERRORS
        console.error('Error while leave history', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});


//Helper Functions

//GET DATE DIFFERENCE IN DAYS
function getDateDiffInDays(startDate, endDate) {
    // Remove the time portion by setting time to 00:00:00  (to avoid time zone issues)
    const start = new Date(startDate.setHours(0, 0, 0, 0));
    const end = new Date(endDate.setHours(0, 0, 0, 0));
  
    const diffInMs = end - start;
    const diffInDays = diffInMs / (1000 * 60 * 60 * 24);
  
    return diffInDays;
}

//GET LEAVE BALANCE
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

//UPDATE LEAVE BALANCE
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

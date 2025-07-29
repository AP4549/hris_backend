const express = require('express');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');
const checkAccess = require('../middleware/checkAccess');
const authorizeFeature = require('../middleware/authorizeFeature');
const checkApprovalAuthority = require('../middleware/checkApprovalAuthority');
const dynamo = require('../services/db');
const { v4: uuidv4 } = require('uuid');

// Constants
const LEAVE_TABLE = process.env.HRIS_LEAVE_TABLE || 'hris_leave';
const USERS_TABLE = process.env.HRIS_USERS_TABLE || 'hris_users';
const LOGS_TABLE = process.env.HRIS_LOGS_TABLE || 'hris_logs';

// POST /leave/request → Employee submits leave
router.post('/request', verifyToken, authorizeFeature('leave', 'create'), async (req, res) => {
    try {
        // Get request body
        const { startDate, endDate, leaveType, reason } = req.body;
        const userId = req.user.id;

        // Check if all required fields are present
        if (!startDate || !endDate || !leaveType || !reason) {
            return res.status(400).json({
                success: false,
                message: 'Required fields missing: startDate, endDate, leaveType, reason'
            });
        }

        // Convert string to date object
        const start = new Date(startDate);
        const end = new Date(endDate);
        const today = new Date();

        // Validate dates
        if (start <= today) {
            return res.status(400).json({
                success: false,
                message: 'Start date must be in the future'
            });
        }

        if (end <= start) {
            return res.status(400).json({
                success: false,
                message: 'End date must be after start date'
            });
        }

        // Calculate leave days
        const leaveDays = getDateDiffInDays(start, end);
        const leaveBalance = await getLeaveBalance(userId, leaveType);
        
        // Check if leave balance is sufficient
        if (leaveBalance < leaveDays) {
            return res.status(400).json({
                success: false,
                message: `Insufficient ${leaveType} leave balance. Available: ${leaveBalance} days, Requested: ${leaveDays} days`
            });
        }

        // Get user details to determine approval chain
        const userResult = await dynamo.get({
            TableName: USERS_TABLE,
            Key: { user_id: userId }
        }).promise();
        
        const user = userResult.Item;
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        // Get manager details
        let approverUserIds = [];
        
        if (user.manager_id) {
            approverUserIds.push(user.manager_id);
            
            // Add manager's manager if exists (for multi-level approval)
            const managerResult = await dynamo.get({
                TableName: USERS_TABLE,
                Key: { user_id: user.manager_id }
            }).promise();
            
            if (managerResult.Item && managerResult.Item.manager_id) {
                approverUserIds.push(managerResult.Item.manager_id);
            }
        }

        // Create leave request object
        const leaveRequest = {
            id: `leave_${uuidv4()}`,
            user_id: userId,
            start_date: start.toISOString(),
            end_date: end.toISOString(),
            leave_type: leaveType,
            reason,
            days: leaveDays,
            status: 'pending',
            submitted_at: new Date().toISOString(),
            approver_user_ids: approverUserIds,
            department: user.department,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };

        // Store leave request in DynamoDB
        await dynamo.put({
            TableName: LEAVE_TABLE,
            Item: leaveRequest
        }).promise();

        // Create log entry
        const logEntry = {
            log_id: `log_${uuidv4()}`,
            action_type: 'leave_request_submitted',
            performed_by_user_id: userId,
            target_user_id: userId,
            timestamp: new Date().toISOString(),
            status: 'completed',
            notes: `Leave request submitted for ${leaveType} from ${startDate} to ${endDate}`
        };

        await dynamo.put({
            TableName: LOGS_TABLE,
            Item: logEntry
        }).promise();

        // Return success response
        res.status(201).json({
            success: true,
            message: 'Leave request submitted successfully',
            data: leaveRequest
        });
    } catch (error) {
        console.error('Error submitting leave request:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});

// PUT /leave/:id/approve → Manager approves
router.put('/:id/approve', verifyToken, authorizeFeature('leave', 'approve'), checkApprovalAuthority(LEAVE_TABLE, 'id'), async (req, res) => {
    try {
        // Get request parameters
        const { id } = req.params;
        const { status, comments } = req.body;
        const approverId = req.user.id;

        // Validate status
        if (!status || !['approved', 'rejected'].includes(status)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid status. Must be "approved" or "rejected"'
            });
        }

        // Leave request is already fetched and verified by checkApprovalAuthority middleware
        const leaveRequest = req.requestData;

        // Check if leave request is pending
        if (leaveRequest.status !== 'pending') {
            return res.status(403).json({
                success: false,
                message: `Leave request is already ${leaveRequest.status}`
            });
        }

        // Get user details
        const userResult = await dynamo.get({
            TableName: USERS_TABLE,
            Key: { user_id: approverId }
        }).promise();

        const approver = userResult.Item;
        if (!approver) {
            return res.status(404).json({
                success: false,
                message: 'Approver not found'
            });
        }

        // Update leave request status
        const updateParams = {
            TableName: LEAVE_TABLE,
            Key: { id },
            UpdateExpression: 'SET #status = :status, approved_by = :approvedBy, approved_at = :approvedAt, comments = :comments, updated_at = :updatedAt',
            ExpressionAttributeNames: {
                '#status': 'status'
            },
            ExpressionAttributeValues: {
                ':status': status,
                ':approvedBy': approverId,
                ':approvedAt': new Date().toISOString(),
                ':comments': comments || '',
                ':updatedAt': new Date().toISOString()
            },
            ReturnValues: 'ALL_NEW'
        };

        const updatedLeave = await dynamo.update(updateParams).promise();

        // Update leave balance if leave is approved
        if (status === 'approved') {
            await updateLeaveBalance(leaveRequest.user_id, leaveRequest.leave_type, leaveRequest.days);
        }

        // Create log entry
        const logEntry = {
            log_id: `log_${uuidv4()}`,
            action_type: `leave_request_${status}`,
            performed_by_user_id: approverId,
            target_user_id: leaveRequest.user_id,
            timestamp: new Date().toISOString(),
            status: 'completed',
            notes: comments || `Leave request ${status} by ${approver.name}`
        };

        await dynamo.put({
            TableName: LOGS_TABLE,
            Item: logEntry
        }).promise();

        // Return success response
        res.json({
            success: true,
            message: `Leave request ${status} successfully`,
            data: updatedLeave.Attributes
        });
    } catch (error) {
        console.error('Error approving leave request:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});

// GET /leave/history/:userId → Fetch leave history
router.get('/history/:userId', verifyToken, async (req, res) => {
    try {
        // Get parameters
        const { userId } = req.params;
        const requestingUserId = req.user.id;

        // Get requesting user details to check access level
        const userResult = await dynamo.get({
            TableName: USERS_TABLE,
            Key: { user_id: requestingUserId }
        }).promise();
        
        const requestingUser = userResult.Item;
        
        if (!requestingUser) {
            return res.status(404).json({
                success: false,
                message: 'Requesting user not found'
            });
        }

        // Check if user has access to fetch leave history
        // Users can access their own data, managers can access their direct reports' data,
        // and admins (access_level 5) can access anyone's data
        const canAccess = 
            requestingUserId === userId || // Own data
            requestingUser.access_level >= 5 || // Admin access
            await isManager(requestingUserId, userId); // Manager access
        
        if (!canAccess) {
            return res.status(403).json({
                success: false,
                message: 'Access denied. Insufficient permissions to view this leave history'
            });
        }

        // Get leave requests from DynamoDB using GSI
        const result = await dynamo.query({
            TableName: LEAVE_TABLE,
            IndexName: 'UserIdIndex',
            KeyConditionExpression: 'user_id = :userId',
            ExpressionAttributeValues: {
                ':userId': userId
            }
        }).promise();

        // Get leave balance
        const leaveBalance = await getLeaveBalance(userId);

        // Return success response
        res.json({
            success: true,
            data: {
                leaveRequests: result.Items || [],
                leaveBalance
            }
        });
    } catch (error) {
        console.error('Error fetching leave history:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});

// POST /attendance/log → Punch in/out
router.post('/attendance/log', verifyToken, authorizeFeature('attendance', 'create'), async (req, res) => {
    try {
        // Get request body
        const { type, location, notes, device } = req.body;
        const userId = req.user.id;

        // Check if attendance type is valid
        if (!type || !['in', 'out'].includes(type)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid attendance type. Must be "in" or "out"'
            });
        }

        // Get current date and time
        const now = new Date();
        const today = now.toISOString().split('T')[0];

        // Check if employee exists
        const userResult = await dynamo.get({
            TableName: USERS_TABLE,
            Key: { user_id: userId }
        }).promise();

        if (!userResult.Item) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        // Check for existing attendance logs today
        const existingLog = await dynamo.query({
            TableName: LEAVE_TABLE,
            IndexName: 'UserAttendanceIndex',
            KeyConditionExpression: 'user_id = :userId AND begins_with(id, :prefix)',
            ExpressionAttributeValues: {
                ':userId': userId,
                ':prefix': `attendance_${today}`
            }
        }).promise();

        const todayLogs = existingLog.Items || [];

        // Validate punch in/out logic
        if (type === 'in') {
            const alreadyIn = todayLogs.some(log => log.type === 'in');
            if (alreadyIn) {
                return res.status(400).json({
                    success: false,
                    message: 'You have already punched in today'
                });
            }
        } else {
            const punchedIn = todayLogs.some(log => log.type === 'in');
            const alreadyPunchedOut = todayLogs.some(log => log.type === 'out');

            if (!punchedIn) {
                return res.status(400).json({
                    success: false,
                    message: 'You have not punched in today'
                });
            }

            if (alreadyPunchedOut) {
                return res.status(400).json({
                    success: false,
                    message: 'You have already punched out today'
                });
            }
        }

        // Create attendance log object
        const attendanceLog = {
            id: `attendance_${today}_${userId}_${type}_${uuidv4().substring(0, 8)}`,
            user_id: userId,
            type,
            date: today,
            timestamp: now.toISOString(),
            location: location || null,
            notes: notes || null,
            device: device || 'web',
            department: userResult.Item.department,
            created_at: now.toISOString(),
            updated_at: now.toISOString()
        };

        // Store attendance log in DynamoDB
        await dynamo.put({
            TableName: LEAVE_TABLE,
            Item: attendanceLog
        }).promise();

        // Create log entry
        const logEntry = {
            log_id: `log_${uuidv4()}`,
            action_type: `attendance_${type}`,
            performed_by_user_id: userId,
            target_user_id: userId,
            timestamp: now.toISOString(),
            status: 'completed',
            notes: `Attendance ${type} logged at ${now.toLocaleTimeString()}`
        };

        await dynamo.put({
            TableName: LOGS_TABLE,
            Item: logEntry
        }).promise();

        // Return success response
        res.status(201).json({
            success: true,
            message: `Attendance punched ${type}`,
            data: attendanceLog
        });
    } catch (error) {
        console.error('Error logging attendance:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});


// Helper Functions

// Check if user is a manager of another user
async function isManager(managerId, employeeId) {
    try {
        const employeeResult = await dynamo.get({
            TableName: USERS_TABLE,
            Key: { user_id: employeeId }
        }).promise();
        
        if (!employeeResult.Item) {
            return false;
        }
        
        return employeeResult.Item.manager_id === managerId;
    } catch (error) {
        console.error('Error checking manager relationship:', error);
        return false;
    }
}

// Get date difference in days
function getDateDiffInDays(startDate, endDate) {
    // Remove the time portion by setting time to 00:00:00 (to avoid time zone issues)
    const start = new Date(startDate.setHours(0, 0, 0, 0));
    const end = new Date(endDate.setHours(0, 0, 0, 0));
  
    const diffInMs = end - start;
    const diffInDays = diffInMs / (1000 * 60 * 60 * 24);
  
    return diffInDays + 1; // Including both start and end days
}

// Get leave balance
async function getLeaveBalance(userId, leaveType = null) {
    try {
        const result = await dynamo.get({
            TableName: LEAVE_TABLE,
            Key: { id: `balance_${userId}` }
        }).promise();

        if (!result.Item) {
            // Initialize leave balance if not exists
            const defaultBalance = {
                id: `balance_${userId}`,
                user_id: userId,
                annual: 20,
                sick: 10,
                personal: 5,
                maternity: 90,
                paternity: 10,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            };
            
            await dynamo.put({
                TableName: LEAVE_TABLE,
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

// Update leave balance
async function updateLeaveBalance(userId, leaveType, daysUsed) {
    try {
        // First, ensure balance exists
        await getLeaveBalance(userId);
        
        const updateParams = {
            TableName: LEAVE_TABLE,
            Key: { id: `balance_${userId}` },
            UpdateExpression: 'SET #leaveType = #leaveType - :daysUsed, updated_at = :updatedAt',
            ExpressionAttributeNames: {
                '#leaveType': leaveType
            },
            ExpressionAttributeValues: {
                ':daysUsed': daysUsed,
                ':updatedAt': new Date().toISOString()
            }
        };

        await dynamo.update(updateParams).promise();
        
        // Log the balance update
        const logEntry = {
            log_id: `log_${uuidv4()}`,
            action_type: 'leave_balance_updated',
            performed_by_user_id: 'system',
            target_user_id: userId,
            timestamp: new Date().toISOString(),
            status: 'completed',
            notes: `Deducted ${daysUsed} days from ${leaveType} leave balance`
        };

        await dynamo.put({
            TableName: LOGS_TABLE,
            Item: logEntry
        }).promise();
    } catch (error) {
        console.error('Error updating leave balance:', error);
        throw error;
    }
}

module.exports = router;

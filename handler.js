const express = require('express');
const cors = require('cors');
const serverless = require('serverless-http');
require('dotenv').config();

// Import routes
const employeeRoutes = require('./src/routes/employee');
const requestsRoutes = require('./src/routes/requests');
const documentsRoutes = require('./src/routes/documents');
const policiesRoutes = require('./src/routes/policies');
const jobsRoutes = require('./src/routes/jobs');
const analyticsRoutes = require('./src/routes/analytics');
const attendanceRoutes = require('./src/routes/attendance');
const payrollRoutes = require('./src/routes/payroll');
const onboardingRoutes = require('./src/routes/onboarding');
const assetsRoutes = require('./src/routes/assets');
const trainingsRoutes = require('./src/routes/trainings');
const systemRoutes = require('./src/routes/system');
const orgChartRoutes = require('./src/routes/orgChart');
const levelsRoutes = require('./src/routes/levels');

// Initialize Express app
const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Use routes
app.use('/api/employee', employeeRoutes);
app.use('/api/requests', requestsRoutes);
app.use('/api/documents', documentsRoutes);
app.use('/api/policies', policiesRoutes);
app.use('/api/jobs', jobsRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/payroll', payrollRoutes);
app.use('/api/onboarding', onboardingRoutes);
app.use('/api/assets', assetsRoutes);
app.use('/api/trainings', trainingsRoutes);
app.use('/api/system', systemRoutes);
app.use('/api/org-chart', orgChartRoutes);
app.use('/api/levels', levelsRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'success',
    message: 'HRIS API is running'
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'success',
    message: 'Welcome to HRIS Backend API',
    version: '1.0.0'
  });
});

// Not found handler
app.use((req, res, next) => {
  res.status(404).json({
    status: 'error',
    message: `Cannot ${req.method} ${req.path}`
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({
    status: 'error',
    message: err.message || 'Internal Server Error'
  });
});

// Export handler for serverless
module.exports.handler = serverless(app);

// Export hello function for backward compatibility
module.exports.hello = async (event) => {
  return {
    statusCode: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': true,
    },
    body: JSON.stringify(
      {
        message: 'Hello from your HRIS Backend!',
        input: event,
      },
      null,
      2
    ),
  };
};

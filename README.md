# HRIS Backend

A serverless HRIS (Human Resource Information System) backend built with AWS Lambda and the Serverless Framework.

## Setup

1. Install dependencies:
   ```
   npm install
   ```

2. Install Serverless Framework globally (if not already installed):
   ```
   npm install -g serverless
   ```

3. Configure AWS credentials:
   ```
   aws configure
   ```

## Development

To run locally:
```
npm run dev
```

This will start the serverless offline server on `http://localhost:3000`

## Deployment

Deploy to development:
```
npm run deploy:dev
```

Deploy to production:
```
npm run deploy:prod
```

## Project Structure

- `serverless.yml` - Serverless Framework configuration
- `handler.js` - Lambda function handlers
- `package.json` - Node.js dependencies and scripts

## API Endpoints

See API documentation for all available endpoints.

## Dynamic Permissions System

The HRIS backend features a dynamic permissions system that allows administrators to define custom access control:

### Key Components

1. **Access Levels**: Configurable numeric levels (1-5) defining the hierarchy of access.
   - Level 1: Basic employee access
   - Level 5: Administrator access

2. **Feature Permissions**: Granular permissions for specific features tied to access levels.
   - Example: `employee.view`, `documents.upload`, etc.

3. **Roles**: Collections of permissions that can be assigned to users.
   - Example: "Department Manager", "HR Specialist", etc.

4. **User-Specific Overrides**: Individual permissions can be granted to specific users.

### Managing Permissions

Administrators can use these endpoints to manage the permission system:

- `GET /api/system/permissions` - List all available permissions
- `POST /api/system/permissions` - Create or update a permission
- `GET /api/system/roles` - List all roles
- `POST /api/system/roles` - Create or update a role
- `POST /api/system/user/permissions` - Assign permissions to a user
- `POST /api/system/user/roles` - Assign roles to a user
- `GET /api/system/access-levels` - Get access level definitions
- `POST /api/system/access-levels` - Update access level definitions

### Authorization Middleware

All protected routes use the `authorizeFeature` middleware which checks:
1. User-specific permission overrides
2. Role-based permissions
3. Access level requirements

Example usage in route definition:
```javascript
router.post('/create', verifyToken, authorizeFeature('training.create'), async (req, res) => {
  // Route handler code
});

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

- `GET /hello` - Test endpoint

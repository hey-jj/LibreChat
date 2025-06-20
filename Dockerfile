# STAGE 1: BUILDER
# This stage installs all dependencies and builds the entire application
FROM node:20-alpine AS builder
WORKDIR /app

# Copy all source code first
COPY . .

# Set resilient npm config
RUN npm config set fetch-retry-maxtimeout 600000 && \
    npm config set fetch-retries 5 && \
    npm config set fetch-retry-mintimeout 15000

# Install ALL dependencies for all workspaces
RUN npm install

# This temporary variable is required ONLY for the build script to succeed
ENV MONGO_URI="mongodb://temp"

# Run the entire frontend build process, which builds all necessary packages
RUN NODE_OPTIONS="--max-old-space-size=4096" npm run frontend


# STAGE 2: PRODUCTION
# This stage creates the final, lean image for running the application
FROM node:20-alpine AS production
WORKDIR /app

# Install jemalloc for performance
RUN apk add --no-cache jemalloc
ENV LD_PRELOAD=/usr/lib/libjemalloc.so.2
ENV NODE_ENV=production

# Copy the entire built application, including all packages and node_modules, from the builder stage.
# This ensures all workspace packages and dependencies are present with the correct paths.
COPY --from=builder /app .

# The Firebase key is copied from the build context, where it's provided by Cloud Build
COPY firebase-service-account-key.json /app/firebase-service-account-key.json
ENV GOOGLE_APPLICATION_CREDENTIALS /app/firebase-service-account-key.json

EXPOSE 8080

# Run the server directly using the final, built entrypoint.
# The working directory is now the project root (/app).
CMD ["node", "./packages/api/dist/index.js"]
# STAGE 1: BUILDER
# This stage installs all dependencies (including dev) and builds the application source code
FROM node:20-alpine AS builder
WORKDIR /app

# Copy the entire source code first
COPY . .

# Set resilient npm config for CI/CD environments
RUN npm config set fetch-retry-maxtimeout 600000 && \
    npm config set fetch-retries 5 && \
    npm config set fetch-retry-mintimeout 15000

# Install ALL dependencies
RUN npm install

# This temporary variable is required ONLY for the build script to succeed
ENV MONGO_URI="mongodb://temp"

# Run the build script
RUN NODE_OPTIONS="--max-old-space-size=4096" npm run frontend


# STAGE 2: PRODUCTION
# This stage creates the final, lean image for running the application
FROM node:20-alpine AS production
WORKDIR /app

# Install jemalloc for performance
RUN apk add --no-cache jemalloc
ENV LD_PRELOAD=/usr/lib/libjemalloc.so.2
ENV NODE_ENV=production

# Copy necessary package files
COPY --from=builder /app/package.json .
COPY --from=builder /app/packages/api/package.json ./packages/api/

# Re-install ONLY production dependencies to create a clean, small node_modules folder
RUN npm install --omit=dev

# Copy the built application code from the builder stage
COPY --from=builder /app/packages/data-provider/dist ./packages/data-provider/dist
COPY --from=builder /app/packages/data-schemas/dist ./packages/data-schemas/dist
COPY --from=builder /app/packages/api/dist ./packages/api/dist

# Copy the Firebase Service Account Key into the final image
COPY firebase-service-account-key.json /app/firebase-service-account-key.json
# Set the standard Google credential variable to point to the file path
ENV GOOGLE_APPLICATION_CREDENTIALS /app/firebase-service-account-key.json

EXPOSE 8080

# CORRECTED: Run the server directly with node, bypassing the problematic npm script.
# The working directory is already /app, and the main server file is at packages/api/dist/server.js
CMD ["node", "packages/api/dist/server.js"]
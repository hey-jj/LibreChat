# Stage 1: Base image with production-grade tools
FROM node:20-alpine AS base
# Install jemalloc for performance and uv for fast package management if needed
RUN apk add --no-cache jemalloc uv
# Set environment variable to use jemalloc
ENV LD_PRELOAD=/usr/lib/libjemalloc.so.2
WORKDIR /app

# Stage 2: Install production dependencies
FROM base AS deps
# Copy only package files to leverage Docker layer caching
COPY package.json package-lock.json* ./
# Set resilient npm config for CI/CD environments
RUN npm config set fetch-retry-maxtimeout 600000 && \
    npm config set fetch-retries 5 && \
    npm config set fetch-retry-mintimeout 15000
# Install only production dependencies
RUN npm install --omit=dev

# Stage 3: Build the application from source
FROM base AS builder
# Copy dependencies from the previous stage
COPY --from=deps /app/node_modules ./node_modules
# Copy the entire application source code
COPY . .
# This temporary variable is required ONLY for the build script to succeed.
# The real MONGO_URI is injected by Cloud Run from Secret Manager at runtime.
ENV MONGO_URI="mongodb://temp"
# Run the build script, allocating more memory to Node.js
RUN NODE_OPTIONS="--max-old-space-size=4096" npm run build

# Stage 4: Final production image
FROM base AS production
ENV NODE_ENV=production

# Copy only the necessary built artifacts from the builder stage
COPY --from=builder /app/packages/data-provider/dist ./packages/data-provider/dist
COPY --from=builder /app/api/dist ./api/dist
COPY --from=builder /app/package.json .

# Copy only the production node_modules from the deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy the Firebase Service Account Key into the final image
# This is the critical step for GCP authentication
COPY firebase-service-account-key.json /app/firebase-service-account-key.json

# Set the standard Google credential variable to point to the file path inside the container
ENV GOOGLE_APPLICATION_CREDENTIALS /app/firebase-service-account-key.json

WORKDIR /app/api
EXPOSE 8080

# The command to start the backend server
CMD ["npm", "run", "backend"]
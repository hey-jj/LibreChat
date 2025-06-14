# Stage 1: Base image with production-grade tools
FROM node:20-alpine AS base
RUN apk add --no-cache jemalloc uv
ENV LD_PRELOAD=/usr/lib/libjemalloc.so.2
WORKDIR /app

# Stage 2: Install ALL dependencies (including dev dependencies needed for the build)
FROM base AS deps
COPY package.json package-lock.json* ./
# Set resilient npm config for CI/CD environments
RUN npm config set fetch-retry-maxtimeout 600000 && \
    npm config set fetch-retries 5 && \
    npm config set fetch-retry-mintimeout 15000
# Install ALL dependencies, including devDependencies like 'rimraf'
RUN npm install

# Stage 3: Build the application from source
FROM base AS builder
# Copy the full node_modules and the source code
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# This temporary variable is required ONLY for the build script to succeed.
ENV MONGO_URI="mongodb://temp"
# Run the build script, which now has access to rimraf and other build tools
RUN NODE_OPTIONS="--max-old-space-size=4096" npm run frontend

# Stage 4: Final production image
FROM base AS production
ENV NODE_ENV=production

# Copy only the necessary files for a lean production image
COPY package.json .
# Install ONLY production dependencies, creating a clean node_modules folder
RUN npm install --omit=dev
# Copy the built application code from the builder stage
COPY --from=builder /app/api/dist ./api/dist
# Copy the Firebase Service Account Key into the final image
COPY firebase-service-account-key.json /app/firebase-service-account-key.json
# Set the standard Google credential variable to point to the file path
ENV GOOGLE_APPLICATION_CREDENTIALS /app/firebase-service-account-key.json

WORKDIR /app/api
EXPOSE 8080
CMD ["npm", "run", "backend"]
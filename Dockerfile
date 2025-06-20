# STAGE 1: BUILDER
# This stage installs all dependencies and builds the entire application
FROM node:20-alpine AS builder
WORKDIR /app

# Copy the entire source code first
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

# Prune dev dependencies from the node_modules folder AFTER the build is complete
RUN npm prune --production


# STAGE 2: PRODUCTION
# This stage creates the final, lean image for running the application
FROM node:20-alpine AS production
WORKDIR /app

# Install jemalloc for performance
RUN apk add --no-cache jemalloc
ENV LD_PRELOAD=/usr/lib/libjemalloc.so.2
ENV NODE_ENV=production

# Copy all necessary artifacts from the builder stage
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/package.json .

# Copy the Firebase Service Account Key into the final image
COPY firebase-service-account-key.json /app/firebase-service-account-key.json
ENV GOOGLE_APPLICATION_CREDENTIALS /app/firebase-service-account-key.json

EXPOSE 8080

# DEFINITIVE CMD: Use the package's direct "start" script via the npm workspace flag.
# This is the correct, official way to run the API service and does not use cross-env.
CMD ["npm", "run", "start", "-w", "@librechat/api"]
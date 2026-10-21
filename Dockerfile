# HeyDenta MCP server as a container for AWS Lambda (via the Lambda Web Adapter) or any host.
# The adapter turns Lambda invocations into plain HTTP on port 8080; the same image also
# runs anywhere with `docker run -p 8080:8080`.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci --ignore-scripts && npm run build && npm prune --omit=dev

FROM node:22-slim
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:1.1.0 /lambda-adapter /opt/extensions/lambda-adapter
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
ENV PORT=8080 NODE_ENV=production HEYDENTA_MCP_STATE=/tmp/heydenta-mcp/bookings.json
EXPOSE 8080
CMD ["node", "dist/http.js"]

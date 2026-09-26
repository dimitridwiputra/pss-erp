FROM node:24.19.0-alpine
WORKDIR /workspace
RUN npm install -g pnpm@11.19.0
COPY . .
RUN pnpm install --frozen-lockfile && pnpm exec turbo run build --filter=@pss/finance-api
ENV PORT=4001
EXPOSE 4001
CMD ["pnpm", "--filter", "@pss/finance-api", "start"]

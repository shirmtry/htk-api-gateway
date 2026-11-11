import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  serverExternalPackages: ['@electric-sql/pglite'],
  outputFileTracingIncludes: {
    '/api/**': ['./migrations/**/*.sql'],
  },
};

export default nextConfig;

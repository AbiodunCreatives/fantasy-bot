/** @type {import('next').NextConfig} */
const nextConfig = {
  basePath: '/arena',
  output: 'export',   // static export — drop into any host under /arena
  trailingSlash: true,
};

module.exports = nextConfig;

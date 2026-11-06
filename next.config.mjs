/** A static site: every day is plain files, so it can be hosted anywhere. @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true }
};

export default nextConfig;

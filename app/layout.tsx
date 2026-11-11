import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'HTK Gateway — API gateway có token bucket và dashboard',
  description:
    'Cấp API key, giới hạn token bucket theo key + endpoint, hạn mức tháng, log bất đồng bộ và dashboard throughput/error/latency.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}

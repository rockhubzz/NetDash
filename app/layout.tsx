import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Network Dashboard',
  description: 'Centralized control surface for self-hosted network devices',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

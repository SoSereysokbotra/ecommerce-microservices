import type { Metadata } from 'next';
import { AuthProvider } from '@/lib/auth-context';
import { AdminLayout } from '@/components/AdminLayout';
import './globals.css';

export const metadata: Metadata = {
  title: 'Commerce Back-Office Console',
  description: 'Enterprise operations, fulfillment, and authorization control center',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>
          <AdminLayout>{children}</AdminLayout>
        </AuthProvider>
      </body>
    </html>
  );
}

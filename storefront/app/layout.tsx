import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Commerce',
  description: 'Order–inventory–payment microservices demo storefront',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site">
          <div className="wrap">
            <Link href="/" className="brand">
              Commerce
            </Link>
            <nav className="row small">
              <Link href="/">Products</Link>
              <Link href="/login">Sign in</Link>
            </nav>
          </div>
        </header>
        <main>
          <div className="wrap">{children}</div>
        </main>
      </body>
    </html>
  );
}

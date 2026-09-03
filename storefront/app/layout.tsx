import type { Metadata } from 'next';
import Link from 'next/link';
import { CartProvider } from '@/components/CartProvider';
import { CartLink } from '@/components/CartLink';
import './globals.css';

export const metadata: Metadata = {
  title: 'Commerce',
  description: 'Order–inventory–payment microservices demo storefront',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* The layout stays a Server Component; only the cart-aware pieces are
            client components, so the header count and the cart page share one
            source of truth. */}
        <CartProvider>
          <header className="site">
            <div className="wrap">
              <Link href="/" className="brand">
                Commerce
              </Link>
              <nav className="row small">
                <Link href="/">Products</Link>
                <CartLink />
                <Link href="/login">Sign in</Link>
              </nav>
            </div>
          </header>
          <main>
            <div className="wrap">{children}</div>
          </main>
        </CartProvider>
      </body>
    </html>
  );
}

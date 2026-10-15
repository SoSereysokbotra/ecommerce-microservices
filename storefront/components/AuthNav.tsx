'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getToken } from '@/lib/api';

export function AuthNav() {
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    setSignedIn(getToken() !== null);
  }, []);

  if (signedIn) {
    return (
      <Link href="/account" data-testid="account-link">
        Account
      </Link>
    );
  }

  return (
    <Link href="/login" data-testid="login-link">
      Sign in
    </Link>
  );
}

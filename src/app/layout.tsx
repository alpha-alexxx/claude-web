import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { shadcn } from "@clerk/ui/themes";
import { ThemeProvider } from "@/components/theme-provider";
import { SIGN_IN_URL, SIGN_UP_URL } from "@/lib/auth/routes";
import "./globals.css";

const geistMono = Geist_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "claude-web",
  description: "A browser wrapper around coding-agent CLIs",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistMono.variable} font-sans min-h-full flex flex-col antialiased`}
      >
        {/* ClerkProvider must sit inside <body> for current Next.js SDKs. The
            local /sign-in and /sign-up routes are passed explicitly rather than
            relying on NEXT_PUBLIC_CLERK_SIGN_IN_URL so that a fresh checkout
            works from the two keys env.ts already requires. */}
        <ClerkProvider
          appearance={{ theme: shadcn }}
          signInUrl={SIGN_IN_URL}
          signUpUrl={SIGN_UP_URL}
        >
          <ThemeProvider>{children}</ThemeProvider>
        </ClerkProvider>
      </body>
    </html>
  );
}

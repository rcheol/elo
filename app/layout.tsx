import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";

export const metadata: Metadata = {
  title: "배드민턴 2대2 ELO 랭킹",
  description: "배드민턴 복식 경기 결과를 입력해 선수별 ELO 랭킹을 관리하세요.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>
        {children}
        <Script
          src="https://unpkg.com/lucide@latest/dist/umd/lucide.min.js"
          strategy="beforeInteractive"
        />
      </body>
    </html>
  );
}

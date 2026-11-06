import type { Metadata } from "next";
import { Darker_Grotesque, Karla } from "next/font/google";
import { Shell } from "@/shared/ui/Shell";
import "./globals.css";

const display = Darker_Grotesque({ subsets: ["latin"], variable: "--font-display", display: "swap" });
const body = Karla({ subsets: ["latin"], variable: "--font-body", display: "swap" });

export const metadata: Metadata = {
  title: "Codevember 2026",
  description: "One word, one real-time 3D experience, every day of November 2026."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body>
        <div className="cv-root">
          <Shell>{children}</Shell>
        </div>
      </body>
    </html>
  );
}

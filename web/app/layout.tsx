import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import "./globals.css";

const controls = IBM_Plex_Sans({
  variable: "--font-controls",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const readout = IBM_Plex_Mono({
  variable: "--font-readout",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "Somite — Visual Bioinformatics",
  description: "Build typed bioinformatics workflows on an infinite canvas.",
  icons: { icon: "/favicon.svg" },
};

export const viewport: Viewport = {
  themeColor: "#050505",
  colorScheme: "dark light",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${controls.variable} ${readout.variable}`}>
        {children}
      </body>
    </html>
  );
}

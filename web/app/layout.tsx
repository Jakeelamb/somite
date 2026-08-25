import type { Metadata, Viewport } from "next";
import { Barlow_Condensed, IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import "./globals.css";

const instrument = Barlow_Condensed({
  variable: "--font-instrument",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
});

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
  title: "Axial — Visual Bioinformatics",
  description: "Build typed bioinformatics workflows on an infinite canvas.",
};

export const viewport: Viewport = {
  themeColor: "#050505",
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      </head>
      <body className={`${instrument.variable} ${controls.variable} ${readout.variable}`}>
        {children}
      </body>
    </html>
  );
}

import type { Metadata } from "next";
import { Archivo_Black, Space_Grotesk } from "next/font/google";
import type { ReactNode } from "react";

import "./styles.css";

/** Neobrutalism's display + body pair, exposed as the tokens its components use. */
const head = Archivo_Black({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-head",
  display: "swap",
});

const sans = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Orbis Arcade",
  description:
    "Turn any image into a controllable world, steered by keyboard and mouse.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${head.variable} ${sans.variable}`}>
      <body>{children}</body>
    </html>
  );
}

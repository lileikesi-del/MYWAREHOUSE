import type { Metadata } from "next";
import Script from "next/script";
import { EngagementTracker } from "@/components/EngagementTracker";
import { STATS_PATH, TRACKED_DOMAIN, UMAMI_WEBSITE_ID } from "@/lib/analytics/umamiProxy";
import "./globals.css";
// Fonts (Inter, Caveat, Long Cang) are vendored as woff2 under public/fonts and
// declared here, instead of next/font/google: the latter downloads from Google
// at build time, which a mainland China build host cannot reach. Regenerate with
// scripts/vendor-fonts.mjs if the families change.
import "./fonts.css";

export const metadata: Metadata = {
  title: "Christmas Cards — 制作与分享你的圣诞贺卡",
  description:
    "挑选圣诞插画卡片、写下专属祝福、上传一首歌，生成链接分享给重要的人。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="font-sans antialiased bg-[#fbfaf9] text-stone-900">
        {/* Loading veil: first thing in the body so it paints before any JS.
            Pure CSS/SVG (no Three.js, no big images) so it can never fail to
            load. window.hideChristmasLoading() fades it out (480ms) once the
            homepage's 3D scene has rendered its first frame. */}
        <div
          id="site-loading"
          className="site-loading"
          role="status"
          aria-live="polite"
          aria-label="圣诞贺卡加载中"
        >
          <div className="loading-inner">
            {/* eslint-disable-next-line @next/next/no-img-element -- in the veil, must not wait on hydration */}
            <img
              className="loading-card"
              src="/assets/brand/loading.svg"
              alt=""
              width={320}
              height={240}
              fetchPriority="high"
            />
            <h1 className="loading-brand">Christmas Cards</h1>
            <p className="loading-message">A little Christmas magic is on its way...</p>
            <div className="loading-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
          </div>
        </div>
        {children}
        {/* Umami analytics through our own domain (lib/analytics/umamiProxy.ts);
            injected only when a website id is configured. data-domains keeps
            local dev and previews out of the numbers. */}
        {UMAMI_WEBSITE_ID ? (
          <Script
            src={`${STATS_PATH}/script.js`}
            data-website-id={UMAMI_WEBSITE_ID}
            data-host-url={STATS_PATH}
            data-domains={TRACKED_DOMAIN || undefined}
            strategy="afterInteractive"
          />
        ) : null}
        <EngagementTracker />
      </body>
    </html>
  );
}

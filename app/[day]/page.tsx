import { notFound } from "next/navigation";
import { dayFromSlug, days, daySlug } from "@/shared/days";

export function generateStaticParams() {
  return days.filter((day) => day.live).map((day) => ({ day: daySlug(day) }));
}

type DayPageProps = {
  params: Promise<{ day: string }>;
};

export async function generateMetadata({ params }: DayPageProps) {
  const { day: slug } = await params;
  const day = dayFromSlug(slug);
  if (!day) return {};

  const title = `${String(day.day).padStart(2, "0")} ${day.word} | Codevember`;
  const description = day.blurb ?? `Day ${day.day} of Codevember 2026: ${day.word}.`;
  return {
    title,
    description,
    openGraph: { title, description, images: day.live ? [`/posters/${slug}.jpg`] : undefined }
  };
}

// The scene and its UI are rendered by Shell in the layout, so they survive moving between days.
// This page exists for the shareable URL, its metadata, and readers without WebGPU or JavaScript.
export default async function DayPage({ params }: DayPageProps) {
  const { day: slug } = await params;
  const day = dayFromSlug(slug);
  if (!day || !day.live) notFound();

  return (
    <noscript>
      <h1>
        Day {day.day}: {day.word}
      </h1>
      <p>{day.blurb} This experience needs JavaScript and a GPU.</p>
    </noscript>
  );
}

import React from 'react';

const DEFAULT_COLORS: [string, string] = ['#e65161', '#f9c387'];

interface Props {
  name: string;
  nameGradientColors?: [string, string] | null;
  className?: string;
}

export default function GradientProjectName({ name, nameGradientColors, className }: Props) {
  const [from, to] = nameGradientColors ?? DEFAULT_COLORS;
  return (
    <span
      className={`bg-clip-text text-transparent inline-block${className ? ` ${className}` : ''}`}
      style={{
        backgroundImage: `linear-gradient(to right, ${from}, ${to})`,
      }}
    >
      {name}
    </span>
  );
}

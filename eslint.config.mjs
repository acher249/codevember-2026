import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const config = [
  { ignores: [".next/", "out/", "next-env.d.ts"] },
  ...nextVitals,
  ...nextTypescript,
  {
    // These are for the React Compiler, which this project does not use. A three.js scene is built once and then changed
    // on every frame by design, which is exactly what they object to.
    rules: {
      "react-hooks/immutability": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/preserve-manual-memoization": "off",
      "react-hooks/use-memo": "off"
    }
  }
];

export default config;

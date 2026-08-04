export default {
  plugins: {
    tailwindcss: {},
    // Autoprefixer reads the browserslist below and adds the -webkit- prefixes
    // old Chrome still needs (notably appearance and sticky positioning).
    autoprefixer: {
      overrideBrowserslist: ['chrome >= 70', 'android >= 7', 'not dead'],
    },
  },
};

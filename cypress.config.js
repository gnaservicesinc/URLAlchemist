const { defineConfig } = require("cypress");

module.exports = defineConfig({
  projectId: 'bvo23m',

  e2e: {
    setupNodeEvents(on, config) {
      // implement node event listeners here
    },
  },
});

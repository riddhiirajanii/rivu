
const handler = require("../../[...route].js");

module.exports = async function sendMessage(req, res) {
  return handler(req, res);
};

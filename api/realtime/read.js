
const handler = require("../[...route].js");

module.exports = async function readMessages(req, res) {
  return handler(req, res);
};

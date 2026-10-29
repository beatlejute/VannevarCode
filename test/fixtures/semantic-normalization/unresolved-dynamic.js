const dynamicMap = ["a", "b", "c"];
function getIndex() { return 1; }
const dynamicResolved = dynamicMap[getIndex()];
const variableIndex = Math.random() * 3;
const variableResolved = dynamicMap[variableIndex];
const userInput = process.argv[2];
const userResolved = dynamicMap[userInput];
const propertyAccess = dynamicMap["length"];
const methodCall = dynamicMap.slice(0, 2)[0];
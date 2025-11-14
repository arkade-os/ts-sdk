async function doPromise () {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      resolve("Hello, world!");
      reject(new Error("test"));
    }, 1000);
  });
}

async function main() {
  try {
    return doPromise()
  } catch (error) {
    console.error(error);
  }
}

main().catch(console.error).then(console.log);
# Fractal Explorer: GPU Edition

This project lets you zoom into, modify, and explore some common fractals. It’s a naive implementation that doesn’t allow for arbitrary precision. This means that it loses resolution at a fairly shallow zoom depth of ~100000x. You can read more and [try it out online](https://rileyjshaw.com/fractal).

This is a quick project I threw together for my own curiosity. It's not precious, so please [add pull requests](https://github.com/rileyjshaw/fractal/pulls) if you have ideas! I’ll merge changes quickly as long as the app remains reasonably performant.

![Example program output](/screenshots/julia.png)

## Running locally

To run this project locally, you'll need to have Git and Node.js installed. Then, run the following commands:

```sh
git clone git@github.com:rileyjshaw/fractal.git
cd fractal
npm install
npm run dev
```

## License

[GNU General Public License v3.0](/LICENSE)

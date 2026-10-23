// Stands in for expo-splash-screen. An app that keeps its splash up with preventAutoHideAsync is saying it has nothing
// to show yet, so a render waits for hide() as a person waits for the splash to go.
import { __splash } from "../index.js"

export const preventAutoHideAsync = async () => {
	__splash.hold()
	return true
}

export const hide = () => {
	__splash.release()
}

export const hideAsync = async () => {
	__splash.release()
}

export const setOptions = () => {}

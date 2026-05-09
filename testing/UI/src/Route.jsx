
import { Route, BrowserRouter as Router, Routes } from 'react-router-dom';
import Test from './Test';
import App from './App';


function Rout () {
    return ( <Router>
        <Routes>
          <Route path="/" element={<App />} />
          <Route path="/auth-callback" element={<Test />} />
         
        </Routes>
      </Router> );
}

export default Rout ;